/**
 * @fileoverview Figure layout for scientific figure export.
 *
 * Every rectangle of an exported figure comes from here — the single-view
 * figure (`computeSingleViewLayout`) and the multi-panel grid
 * (`computeGridFigureLayout`) — so the SVG and PNG renderers, and the
 * export preview, place identical rectangles from one source.
 *
 * KEY DESIGN DECISIONS:
 * - A plot has its view's aspect (the pane's viewport, or the framing crop's;
 *   `figureSourceAspect` in `plot-fit.js`) and the view fills it exactly: a
 *   figure is never letterboxed, and no blank band lies inside or beside a
 *   plot.
 * - Single view: the user-specified width × height is the PLOT's bounding
 *   box: the plot is the largest rectangle of its view's aspect inside it
 *   (`fitPlotSize`). Legend, axes and title are added around the fitted plot,
 *   so the plot keeps its size and aspect ratio whatever is annotated.
 * - Grid: width × height is the box the composed figure fits: every panel's
 *   plot has one height and its view's aspect, and the figure is exactly as
 *   large as its panels, axis margins, labels and legends need at the largest
 *   plot height that fits — never padded out to the box. It is larger than the
 *   box only to keep every plot readable (`PANEL_PLOT_MIN_WIDTH` ×
 *   `PANEL_PLOT_MIN_HEIGHT`) or a title whole.
 * - Axes (and their margins) only on a plot that has them
 *   (`figureViewHasAxes` in `components/axes-builder.js`). A plot's axes are
 *   laid out here once (`planFigureAxes`), from its measured tick labels and
 *   the fonts, and its margins are what they need on each side: nothing
 *   overlaps at any text size, and both renderers draw that one plan.
 * - Where the figure draws highlighted cells, its legend carries an entry
 *   for them (`utils/highlight-legend.js`), sized with the legend.
 * - A legend's box is the box its entries need, never stretched to the plot.
 * - A legend is as large as its entries need (`planLegend()` in
 *   `components/legend-builder.js`): every entry is drawn whole, in columns as
 *   wide as the longest entry, `(hidden)` marker included. Nothing caps it at
 *   the plot's size; a legend too large for the browser to draw is refused
 *   before the figure is rendered (`utils/figure-canvas.js`), never cut.
 * - Legend widths come from one text measurement (`utils/text-measure.js`),
 *   and the builders draw the plan made with it, so the box reserved here is
 *   never narrower than what is drawn in it.
 *
 * @module ui/modules/figure-export/utils/layout
 */

import {
  planLegend,
  resolveSharedGridLegend,
} from '../components/legend-builder.js';
import {
  computeSourceAxisBounds,
  figurePanelAxes,
  planFigureAxes,
} from '../components/axes-builder.js';
import { clamp } from '../../../../utils/number-utils.js';
import { figureTextMeasure } from './text-measure.js';
import { figureSourceAspect, fitPlotSize } from './plot-fit.js';
import { panelTitle } from './panel-label.js';
import { figureHighlightLegend } from './highlight-legend.js';
import { vectorFieldLegendKey } from '../components/vector-field-figure.js';

// ============================================================================
// Layout Constants
// ============================================================================

/** Outer padding around the entire figure (px) */
const OUTER_PADDING = 20;

/** Height reserved for title when present (px) */
const TITLE_HEIGHT = 34;

/** The title font a layout is given none (px). */
const TITLE_DEFAULT_FONT_PX = 14;

/** Gap between the plot (or grid) with its axis margin and the legend (px) */
const LEGEND_GAP = 16;

/**
 * The least width of a legend beside the plot or the grid, in ems of its
 * font: the length of its color bar, and the box a short category legend
 * sits in (120 px at 12 px; 25 mm at 7 pt, a print color bar's length). A
 * legend whose entries or title need more is as wide as they need. In ems, so
 * a figure set in print sizes (`utils/figure-size.js`) keeps the legend in
 * proportion to its text: a fixed 240 px (63 mm) left a single-column
 * figure's plot 15 mm wide (F271).
 */
const LEGEND_MIN_EMS_BESIDE = 10;
const legendMinWidthBeside = fontPx => LEGEND_MIN_EMS_BESIDE * fontPx;

/**
 * The least room around a single view's plot (px): its margin on a side where
 * its axes need no more (`FigureAxes.margins`, from the fonts and the tick
 * labels), and on every side of a plot without axes.
 */
const PLOT_PADDING = 10;

/**
 * Panel geometry for grid (multi-panel) exports.
 *
 * A panel legend is drawn only when the panels disagree, beside its plot
 * (`PANEL_LEGEND_GAP` from the plot's axis margin) or below it, and is at
 * least `PANEL_LEGEND_MIN_WIDTH` wide (its color bar's length).
 *
 * A panel's plot is never smaller than `PANEL_PLOT_MIN_WIDTH` ×
 * `PANEL_PLOT_MIN_HEIGHT`: a box too small for that makes the figure larger.
 */
const PANEL_LEGEND_GAP = 8;
const PANEL_LEGEND_MIN_WIDTH = 96;
/**
 * Legends take their room from the plots, inside the requested box, until the
 * plots keep `PANEL_LEGEND_SHARE` of the height they have without legends;
 * past that the figure grows to hold the legends: a long legend never shrinks
 * the data it explains to a thumbnail.
 */
const PANEL_LEGEND_SHARE = 0.5;
const PANEL_PLOT_MIN_WIDTH = 80;
const PANEL_PLOT_MIN_HEIGHT = 64;

/** Float sums of sizes land a hair over whole pixels; this is not growth. */
const GROWTH_EPSILON = 1e-6;

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
 * @typedef {import('../components/legend-builder.js').LegendPlan} LegendPlan
 * @typedef {import('./text-measure.js').MeasureText} MeasureText
 * @typedef {import('../components/axes-builder.js').AxesSpec} AxesSpec
 * @typedef {import('../components/axes-builder.js').FigureAxes} FigureAxes
 * @typedef {import('./highlight-legend.js').HighlightLegendEntry} HighlightLegendEntry
 * @typedef {import('./highlight-legend.js').FigureHighlightLegend} FigureHighlightLegend
 */

/**
 * @typedef {object} SingleViewLayout
 * @property {number} outerPadding    - Outer padding value used
 * @property {number} totalWidth      - Total output width
 * @property {number} totalHeight     - Total output height
 * @property {number} titleFontPx     - The title's font size (px)
 * @property {Rect|null} titleRect    - Title area rectangle (null if no title)
 * @property {Rect} plotRect          - Plot content area rectangle
 * @property {FigureAxes|null} axes   - The plot's axes as both renderers draw them (null: none)
 * @property {Rect|null} legendRect   - Legend area rectangle (null if no legend)
 * @property {LegendPlan|null} legendPlan - What the legend builder draws in legendRect
 * @property {boolean} vectorKeyInLegend - The vector field's key is rows of the legend (else in the plot)
 */

/**
 * The title's font size: the one asked for. Text keeps the size it is set in
 * (a figure's points, `utils/figure-size.js`), so no floor raises it.
 */
function titleFontOf(titleFontSizePx) {
  const size = Number(titleFontSizePx);
  return size > 0 ? size : TITLE_DEFAULT_FONT_PX;
}

/** A legend font size as the builders draw it: the one asked for (a point size is not rounded to whole px). */
function legendFontOf(legendFontSizePx) {
  const size = Number(legendFontSizePx);
  return size > 0 ? size : 12;
}

// ============================================================================
// Single view
// ============================================================================

/**
 * Compute the layout of a single-view figure export.
 *
 * IMPORTANT: `width` × `height` is the PLOT's bounding box, not the output
 * size. The plot is the largest rectangle of `plotAspect` inside it (one side
 * is the requested one, the other shorter), and the output is LARGER, to hold
 * axes, title and legend around that fitted plot.
 *
 * The legend stands beside the plot (right) or below it (bottom), past the
 * axis margin and a gap, and is as large as its entries need: beside, its
 * entries fill the plot's height in as many columns as they take; below, they
 * fill the plot's width in as many rows as they take, and a single column
 * wider than the plot makes the figure wider. A title wider than the figure
 * widens it too: nothing is cut.
 *
 * The axes' margins are what their text needs (`planFigureAxes`): the y-axis
 * label past the widest tick label, a corner tick label or a long axis label
 * past the plot's other sides; at least `PLOT_PADDING` on every side.
 *
 * @param {object} options
 * @param {number} options.width              - The plot's bounding-box width (px)
 * @param {number} options.height             - The plot's bounding-box height (px)
 * @param {number} options.plotAspect         - The view's aspect, width / height
 *   (`figureSourceAspect`): the plot takes it
 * @param {string} [options.title='']         - Figure title (empty string = no title)
 * @param {number} [options.titleFontSizePx]  - Title font size (px)
 * @param {AxesSpec|null} [options.axes=null] - What the plot's axes show: the
 *   person's Axes choice, for a view that has them (`figureViewHasAxes`) and
 *   whose bounds are known (`computeSourceAxisBounds`); null draws none
 * @param {boolean} [options.includeLegend=true] - Whether to include legend
 * @param {LegendPosition} [options.legendPosition='right'] - Legend position
 * @param {any} [options.legendModel=null]    - Legend model; null draws no legend
 *   unless the figure draws highlighted cells
 * @param {HighlightLegendEntry|null} [options.legendHighlight=null] - The legend's
 *   entry for the highlighted cells the plot draws (`figureHighlightLegend`)
 * @param {{label: string, speed: string, colormapId: string}|null} [options.legendVectorKey=null] -
 *   the key of the vector field the plot draws (`vectorFieldLegendKey`): rows of the legend
 * @param {string|null} [options.legendFieldKey=null] - The legend's title
 * @param {number} [options.legendFontSizePx=12] - Legend font size (px)
 * @param {string} [options.fontFamily]       - The figure's font family
 * @param {MeasureText|null} [options.measureText=null] - Text measurement (default: the browser's, for `fontFamily`)
 * @returns {SingleViewLayout}
 */
export function computeSingleViewLayout({
  width,
  height,
  plotAspect,
  title = '',
  titleFontSizePx = TITLE_DEFAULT_FONT_PX,
  axes: axesSpec = null,
  includeLegend = true,
  legendPosition = 'right',
  legendModel = null,
  legendFieldKey = null,
  legendHighlight = null,
  legendVectorKey = null,
  legendFontSizePx = 12,
  fontFamily = 'Arial, Helvetica, sans-serif',
  measureText = null,
}) {
  const measure = measureText ?? figureTextMeasure(fontFamily);
  const titleText = String(title || '').trim();
  const hasTitle = titleText !== '';
  const titleFontPx = titleFontOf(titleFontSizePx);
  const { width: plotWidth, height: plotHeight } = fitPlotSize({
    aspect: plotAspect,
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  });

  const axes = axesSpec === null
    ? null
    : planFigureAxes({ ...axesSpec, plotWidth, plotHeight, measureText: measure });
  const margin = side => Math.max(PLOT_PADDING, axes === null ? 0 : axes.margins[side]);
  const axisLeft = margin('left');
  const axisRight = margin('right');
  const axisTop = margin('top');
  const axisBottom = margin('bottom');
  const titleSpace = hasTitle ? TITLE_HEIGHT : 0;

  const plotRect = {
    x: OUTER_PADDING + axisLeft,
    y: OUTER_PADDING + titleSpace + axisTop,
    width: plotWidth,
    height: plotHeight
  };
  const plotRight = plotRect.x + plotWidth + axisRight;
  const plotBottom = plotRect.y + plotHeight + axisBottom;

  /** @type {Rect|null} */
  let legendRect = null;
  /** @type {LegendPlan|null} */
  let legendPlan = null;
  if (includeLegend && (legendModel || legendHighlight || legendVectorKey)) {
    const fontPx = legendFontOf(legendFontSizePx);
    if (legendPosition === 'right') {
      legendPlan = planLegend({
        model: legendModel,
        fieldKey: legendFieldKey,
        fontPx,
        measureText: measure,
        placement: 'beside',
        extentPx: plotHeight,
        minWidth: legendMinWidthBeside(fontPx),
        highlight: legendHighlight,
        vectorKey: legendVectorKey,
      });
      legendRect = {
        x: plotRight + LEGEND_GAP,
        y: plotRect.y,
        width: legendPlan.width,
        height: legendPlan.height,
      };
    } else {
      legendPlan = planLegend({
        model: legendModel,
        fieldKey: legendFieldKey,
        fontPx,
        measureText: measure,
        placement: 'below',
        extentPx: plotWidth,
        highlight: legendHighlight,
        vectorKey: legendVectorKey,
      });
      legendRect = {
        x: plotRect.x,
        y: plotBottom + LEGEND_GAP,
        width: legendPlan.width,
        height: legendPlan.height,
      };
    }
  }

  const titleWidth = hasTitle ? measure(titleText, titleFontPx) : 0;
  const contentRight = Math.max(
    plotRight,
    legendRect ? legendRect.x + legendRect.width : 0,
    OUTER_PADDING + titleWidth
  );
  const contentBottom = Math.max(
    plotBottom,
    legendRect ? legendRect.y + legendRect.height : 0
  );
  const totalWidth = Math.ceil(contentRight + OUTER_PADDING);
  const totalHeight = Math.ceil(contentBottom + OUTER_PADDING);

  return {
    outerPadding: OUTER_PADDING,
    totalWidth,
    totalHeight,
    titleFontPx,
    titleRect: hasTitle
      ? { x: OUTER_PADDING, y: OUTER_PADDING, width: totalWidth - OUTER_PADDING * 2, height: TITLE_HEIGHT }
      : null,
    plotRect,
    axes,
    legendRect,
    legendPlan,
    // The vector field's key is the legend's rows; else the plot draws it in its corner.
    vectorKeyInLegend: legendPlan !== null && legendPlan.vectorKey !== null && legendPlan.vectorKey !== undefined,
  };
}

// ============================================================================
// Grid
// ============================================================================

/** Whether two vector field keys read the same (one legend can hold both panels'). */
function sameVectorKey(left, right) {
  return left.label === right.label && left.speed === right.speed && left.colormapId === right.colormapId;
}

/**
 * Grid dimensions (columns × rows) for multi-panel figures: the arrangement
 * the on-screen grid has, `columns` (the export engine reads it from the
 * viewer's rule, `getPresentedGridColumns`, for the area the panes are
 * shown in), so an exported grid is arranged as the person sees it.
 *
 * @param {number} count - Number of panels to arrange
 * @param {number} columns - The on-screen arrangement's columns
 * @returns {{ cols: number; rows: number }}
 */
export function computeGridDims(count, columns) {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError('A grid figure arranges one or more panels.');
  }
  if (!Number.isSafeInteger(columns) || columns < 1) {
    throw new RangeError('A grid figure needs its arrangement\'s columns (a whole number, at least 1).');
  }
  const cols = Math.min(columns, count);
  return { cols, rows: Math.ceil(count / cols) };
}

/**
 * The fixed parts of every grid cell: its padding and the panel label row.
 *
 * @param {number} fontSize - Panel label font size (px)
 */
function gridCellMetrics(fontSize) {
  return {
    padding: clamp(Math.round(fontSize * 0.65), 6, 12),
    header: Math.max(18, Math.round(fontSize * 1.5)),
  };
}

/**
 * @typedef {object} GridLegendSpec
 * @property {any} model
 * @property {string|null} fieldKey
 * @property {'right'|'below'} side
 * @property {HighlightLegendEntry|null} highlight
 * @property {{label: string, speed: string, colormapId: string}|null} vectorKey
 */

/**
 * The grid composed around one plot height: every panel's plot is
 * `plotHeight` tall and `plotHeight × aspect` wide, the columns and rows are
 * as large as their panels need, and the legends are planned for that size.
 *
 * - A column has axis margins when one of its panels has axes, a row a bottom
 *   axis margin when one of its panels has: the plots of a column start at one
 *   x, those of a row at one y. Each panel's axes are planned for its plot
 *   (`planFigureAxes`), and a column's or row's margin is the largest its
 *   panels' axes need, a row's top margin included (a tick label at a plot's
 *   top corner reaches above it, under the panel's title).
 * - A panel legend on the right stands beside its plot, planned against the
 *   plot's height (`placement: 'beside'`), and widens its column; one below
 *   stands under the plot's axis margin at the column's inner width, and
 *   deepens its row.
 * - A shared legend stands beside the grid, its top level with the first
 *   row's plots, or below it, as wide as the grid's inner width.
 * - A panel's title (`panelTitle`, drawn from its plot's left edge) widens its
 *   column when it is wider than what the column holds: a title is never cut
 *   off (L24-2: "C. Neurog3 (endocrine pro" at 24 px in three columns).
 */
function composeGrid({
  plotHeight,
  cols,
  rows,
  plotAspects,
  titleWidths,
  panelAxes,
  paneLegends,
  sharedLegend,
  legendPosition,
  metrics,
  legendFontPx,
  measure,
}) {
  const { padding, header } = metrics;
  const colAxisLeft = new Array(cols).fill(0);
  const colAxisRight = new Array(cols).fill(0);
  const colPlotWidth = new Array(cols).fill(0);
  const colLegendWidth = new Array(cols).fill(0);
  const rowAxisTop = new Array(rows).fill(0);
  const rowAxisBottom = new Array(rows).fill(0);
  const rowBelow = new Array(rows).fill(0);
  const rowBeside = new Array(rows).fill(0);
  const colOf = index => index % cols;
  const rowOf = index => Math.floor(index / cols);

  const axes = plotAspects.map((aspect, index) => {
    const col = colOf(index);
    const row = rowOf(index);
    colPlotWidth[col] = Math.max(colPlotWidth[col], plotHeight * aspect);
    if (panelAxes[index] === null) return null;
    const planned = planFigureAxes({
      ...panelAxes[index],
      plotWidth: plotHeight * aspect,
      plotHeight,
      measureText: measure,
    });
    colAxisLeft[col] = Math.max(colAxisLeft[col], planned.margins.left);
    colAxisRight[col] = Math.max(colAxisRight[col], planned.margins.right);
    rowAxisTop[row] = Math.max(rowAxisTop[row], planned.margins.top);
    rowAxisBottom[row] = Math.max(rowAxisBottom[row], planned.margins.bottom);
    return planned;
  });

  const plans = paneLegends.map((legend, index) => {
    if (legend === null || legend.side !== 'right') return null;
    const plan = planLegend({
      model: legend.model,
      fieldKey: legend.fieldKey,
      fontPx: legendFontPx,
      measureText: measure,
      placement: 'beside',
      extentPx: plotHeight,
      minWidth: PANEL_LEGEND_MIN_WIDTH,
      highlight: legend.highlight,
      vectorKey: legend.vectorKey,
    });
    colLegendWidth[colOf(index)] = Math.max(colLegendWidth[colOf(index)], PANEL_LEGEND_GAP + plan.width);
    rowBeside[rowOf(index)] = Math.max(rowBeside[rowOf(index)], plan.height);
    return plan;
  });

  const colInner = colPlotWidth.map((plotWidth, col) => colAxisLeft[col] + plotWidth + colAxisRight[col] + colLegendWidth[col]);
  // A title starts where its plot starts (a narrower plot is centered in its column).
  titleWidths.forEach((titleWidth, index) => {
    const col = colOf(index);
    const titleLeft = colAxisLeft[col] + (colPlotWidth[col] - plotHeight * plotAspects[index]) / 2;
    colInner[col] = Math.max(colInner[col], titleLeft + titleWidth);
  });
  const planBelow = (legend, extentPx) => planLegend({
    model: legend.model,
    fieldKey: legend.fieldKey,
    fontPx: legendFontPx,
    measureText: measure,
    placement: 'below',
    extentPx,
    minWidth: PANEL_LEGEND_MIN_WIDTH,
    highlight: legend.highlight,
    vectorKey: legend.vectorKey,
  });
  // A legend below is as wide as its column; a single column of entries wider
  // than the column widens it, and the column's legends are planned again at
  // the width it ends with.
  paneLegends.forEach((legend, index) => {
    if (legend === null || legend.side !== 'below') return;
    const col = colOf(index);
    colInner[col] = Math.max(colInner[col], planBelow(legend, colInner[col]).width);
  });
  paneLegends.forEach((legend, index) => {
    if (legend === null || legend.side !== 'below') return;
    const plan = planBelow(legend, colInner[colOf(index)]);
    plans[index] = plan;
    rowBelow[rowOf(index)] = Math.max(rowBelow[rowOf(index)], PANEL_LEGEND_GAP + plan.height);
  });

  const colWidths = colInner.map(inner => padding * 2 + inner);
  const rowHeights = rowAxisBottom.map((axisBottom, row) => padding * 2 + header + rowAxisTop[row]
    + Math.max(plotHeight + axisBottom + rowBelow[row], rowBeside[row]));
  const gridWidth = colWidths.reduce((sum, width) => sum + width, 0);
  const gridHeight = rowHeights.reduce((sum, height) => sum + height, 0);

  /** @type {LegendPlan|null} */
  let sharedPlan = null;
  let contentWidth = gridWidth;
  let contentHeight = gridHeight;
  if (sharedLegend !== null && legendPosition === 'right') {
    sharedPlan = planLegend({
      model: sharedLegend.model,
      fieldKey: sharedLegend.fieldKey,
      fontPx: legendFontPx,
      measureText: measure,
      placement: 'beside',
      extentPx: gridHeight - padding * 2 - header - rowAxisTop[0],
      minWidth: legendMinWidthBeside(legendFontPx),
      highlight: sharedLegend.highlight,
      vectorKey: sharedLegend.vectorKey,
    });
    contentWidth = gridWidth + LEGEND_GAP + sharedPlan.width;
    contentHeight = Math.max(gridHeight, padding + header + rowAxisTop[0] + sharedPlan.height);
  } else if (sharedLegend !== null) {
    sharedPlan = planLegend({
      model: sharedLegend.model,
      fieldKey: sharedLegend.fieldKey,
      fontPx: legendFontPx,
      measureText: measure,
      placement: 'below',
      extentPx: gridWidth - padding * 2,
      highlight: sharedLegend.highlight,
      vectorKey: sharedLegend.vectorKey,
    });
    contentWidth = Math.max(gridWidth, padding * 2 + sharedPlan.width);
    contentHeight = gridHeight + LEGEND_GAP + sharedPlan.height;
  }

  return {
    plotHeight,
    axes,
    colAxisLeft,
    colAxisRight,
    colPlotWidth,
    rowAxisTop,
    rowAxisBottom,
    colWidths,
    rowHeights,
    gridWidth,
    gridHeight,
    plans,
    sharedPlan,
    contentWidth,
    contentHeight,
  };
}

/**
 * @typedef {object} GridPaneLayout
 * @property {any} legendModel          - The panel's own legend model, or null
 * @property {string|null} legendFieldKey
 * @property {LegendPlan|null} legendPlan
 * @property {'right'|'below'|null} legendSide
 * @property {number} labelX
 * @property {number} labelY
 * @property {Rect} panelRect
 * @property {Rect} plotRect
 * @property {FigureAxes|null} axes - the panel's axes as both renderers draw them (null: none)
 * @property {Rect|null} legendRect
 * @property {boolean} vectorKeyInLegend - its vector field's key is rows of a legend (else in its plot)
 */

/**
 * @typedef {object} GridFigureLayout
 * @property {number} outerPadding
 * @property {number} totalWidth
 * @property {number} totalHeight
 * @property {number} plotHeight      - every panel's plot height (px)
 * @property {number} titleFontPx
 * @property {Rect|null} titleRect
 * @property {{fieldKey: string|null, model: any, highlight: HighlightLegendEntry|null}|null} sharedLegend
 * @property {Rect|null} sharedLegendRect
 * @property {LegendPlan|null} sharedLegendPlan
 * @property {GridPaneLayout[]} panes
 */

/**
 * Compute the whole layout of a multi-panel ("Export all views") figure: a
 * composed figure, as a person would assemble it for a paper.
 *
 * - Every panel's plot has one height and its own view's aspect
 *   (`plotAspects`: the pane's shape on screen, or the framing crop's), so
 *   panels of one shape are one size, the plots of a row start at one height
 *   and those of a column at one x.
 * - `width` × `height` is the box the figure must fit: the plot height is the
 *   largest whole number of pixels whose composed figure — plots, axis
 *   margins, labels, legends, title row — fits inside it, and the figure is
 *   exactly that composition (one side reaches the box, the other is
 *   shorter), never padded out to the box. The figure is larger than the box
 *   only where a panel's plot would fall below `PANEL_PLOT_MIN_WIDTH` ×
 *   `PANEL_PLOT_MIN_HEIGHT`, below `PANEL_LEGEND_SHARE` of the height it has
 *   in the box without legends (the legends then get the room they need
 *   around plots of that height), or a title is wider than it. A panel's
 *   title (`panelTitle`) is part of the composition: it widens its column
 *   where it is wider than the column's plot and legend, so the plots shrink
 *   to keep the figure in the box rather than the title being cut off.
 * - Axis margins exist only for panels with axes (`panelAxes`,
 *   `figurePanelAxes` in `components/axes-builder.js`): a grid of 3-D views
 *   wastes no gutter on axes it does not draw. They are as large as each
 *   panel's axes need at the plot height tried (`planFigureAxes`), so the
 *   figure's fit accounts for its fonts.
 *
 * LEGENDS:
 * - When every panel agrees (`resolveSharedGridLegend`), one shared legend
 *   stands beside the grid (right) or below it (bottom), sized to its entries.
 * - Otherwise each colored panel draws its own legend in its cell. On the
 *   right it stands beside its plot, filling the plot's height in as many
 *   columns as its entries take; a legend that, beside the plot the grid has
 *   without legends, would be wider than that plot stands below its plot
 *   instead, as with Legend: Bottom, at the column's width. When that
 *   arrangement does not keep to the box (the legends would take more than
 *   their share of the plots' height), every legend beside, then every
 *   legend below, is tried; the first that keeps to the box is drawn, else
 *   the one reaching least past it.
 * - A legend's box is the box its entries need (`planLegend`), not stretched
 *   to the plot.
 * - Where panels draw highlighted cells (`legendHighlight`), the legend
 *   standing for them carries the highlight's entry: the shared legend when
 *   any panel draws them, else each such panel's own legend (a panel colored
 *   by no field then has a legend of the highlight alone). When no panel is
 *   colored by a field, one shared legend lists the highlight.
 *
 * Every rectangle is disjoint from every other: panel legends from plots,
 * axis margins and labels, the shared legend from the grid.
 *
 * @param {object} options
 * @param {number} options.width            - The box the figure fits (px)
 * @param {number} options.height
 * @param {number} options.columns          - The arrangement's columns (`computeGridDims`)
 * @param {ReadonlyArray<{ scientificState: { fieldKey: string|null; legendModel: any } }>} options.views
 * @param {ReadonlyArray<number>} options.plotAspects - each view's aspect,
 *   width / height (`figureSourceAspect`), in `views` order
 * @param {ReadonlyArray<AxesSpec|null>} options.panelAxes - what each panel's
 *   axes show, null where it draws none (`figurePanelAxes`), in `views` order
 * @param {FigureHighlightLegend|null} [options.legendHighlight=null] - the
 *   highlight's legend entry and which panels draw highlighted cells
 *   (`figureHighlightLegend`)
 * @param {ReadonlyArray<{label: string, speed: string, colormapId: string}|null>|null} [options.legendVectorKeys=null] -
 *   each panel's vector field key (`vectorFieldLegendKey`), null where it draws none: in the
 *   shared legend when every panel's is the same, else in its panel's own legend; a panel whose
 *   key no legend holds draws it in its plot (`pane.vectorKeyInLegend`)
 * @param {string} [options.title='']
 * @param {number} [options.titleFontSizePx]
 * @param {boolean} [options.includeLegend=true]
 * @param {LegendPosition} [options.legendPosition='right']
 * @param {number} options.fontSize         - Panel label font size (px)
 * @param {number} [options.legendFontSizePx=12]
 * @param {string} [options.fontFamily]
 * @param {MeasureText|null} [options.measureText=null]
 * @returns {GridFigureLayout}
 */
export function computeGridFigureLayout({
  width,
  height,
  columns,
  views,
  plotAspects,
  panelAxes,
  title = '',
  titleFontSizePx = TITLE_DEFAULT_FONT_PX,
  includeLegend = true,
  legendPosition = 'right',
  legendHighlight = null,
  legendVectorKeys = null,
  fontSize,
  legendFontSizePx = 12,
  fontFamily = 'Arial, Helvetica, sans-serif',
  measureText = null,
}) {
  if (!Array.isArray(plotAspects) || plotAspects.length !== views.length) {
    throw new TypeError('Grid figure layout requires one plot aspect per view.');
  }
  if (
    !Array.isArray(panelAxes)
    || panelAxes.length !== views.length
    || panelAxes.some(axes => axes !== null && (typeof axes !== 'object' || typeof axes.bounds !== 'object' || axes.bounds === null))
  ) {
    throw new TypeError('Grid figure layout requires what each panel\'s axes show, or null (figurePanelAxes).');
  }
  if (legendHighlight !== null && (!Array.isArray(legendHighlight.panels) || legendHighlight.panels.length !== views.length)) {
    throw new TypeError('Grid figure layout requires whether each panel draws highlighted cells.');
  }
  for (const aspect of plotAspects) {
    if (!(typeof aspect === 'number' && Number.isFinite(aspect) && aspect > 0)) {
      throw new TypeError('A grid panel\'s plot aspect must be a finite positive number.');
    }
  }
  const measure = measureText ?? figureTextMeasure(fontFamily);
  const titleText = String(title || '').trim();
  const hasTitle = titleText !== '';
  const titleFontPx = titleFontOf(titleFontSizePx);
  const legendFontPx = legendFontOf(legendFontSizePx);
  const titleSpace = hasTitle ? TITLE_HEIGHT : 0;
  const contentX = OUTER_PADDING;
  const contentY = OUTER_PADDING + titleSpace;
  const boxWidth = Math.max(1, Math.round(width));
  const boxHeight = Math.max(1, Math.round(height));
  const { cols, rows } = computeGridDims(views.length, columns);
  const metrics = gridCellMetrics(fontSize);
  const highlightOf = index => (legendHighlight !== null && legendHighlight.panels[index] ? legendHighlight.entry : null);
  const sharedHighlight = legendHighlight !== null && legendHighlight.panels.some(Boolean) ? legendHighlight.entry : null;
  // Each panel's vector field key; one for every panel when they are the same.
  if (legendVectorKeys !== null && (!Array.isArray(legendVectorKeys) || legendVectorKeys.length !== views.length)) {
    throw new TypeError('Grid figure layout requires one vector field key (or null) per panel.');
  }
  const vectorKeyOf = index => (includeLegend && legendVectorKeys !== null ? legendVectorKeys[index] ?? null : null);
  const drawnKeys = views.map((_view, index) => vectorKeyOf(index)).filter(key => key !== null);
  const sharedVectorKey = drawnKeys.length > 0 && drawnKeys.every(key => sameVectorKey(key, drawnKeys[0])) ? drawnKeys[0] : null;
  // One legend for every panel when they agree; one of the highlight or the
  // vector field's key alone when no panel is colored by a field but some
  // draw highlighted cells or the same field.
  const agreed = includeLegend ? resolveSharedGridLegend(views) : null;
  const uncolored = views.every(view => view.scientificState.legendModel == null);
  const keysAgree = drawnKeys.length === 0 || sharedVectorKey !== null;
  const sharedLegend = agreed !== null
    ? { ...agreed, highlight: sharedHighlight, vectorKey: sharedVectorKey }
    : (includeLegend && uncolored && keysAgree && (sharedHighlight !== null || sharedVectorKey !== null)
      ? { fieldKey: null, model: null, highlight: sharedHighlight, vectorKey: sharedVectorKey }
      : null);
  const titleWidths = views.map((view, index) => measure(panelTitle(view, index), fontSize));

  // The least plot height that keeps every panel's plot readable.
  let minPlotHeight = PANEL_PLOT_MIN_HEIGHT;
  for (const aspect of plotAspects) minPlotHeight = Math.max(minPlotHeight, PANEL_PLOT_MIN_WIDTH / aspect);
  minPlotHeight = Math.ceil(minPlotHeight - GROWTH_EPSILON);

  const compose = (plotHeight, paneLegends, shared = sharedLegend) => composeGrid({
    plotHeight,
    cols,
    rows,
    plotAspects,
    titleWidths,
    panelAxes,
    paneLegends,
    sharedLegend: shared,
    legendPosition,
    metrics,
    legendFontPx,
    measure,
  });
  /** How far a composition reaches past the box: its larger ratio of side to box side (1 or less fits). */
  const overflowOf = (grid) => Math.max(
    (OUTER_PADDING * 2 + grid.contentWidth) / boxWidth,
    (OUTER_PADDING * 2 + titleSpace + grid.contentHeight) / boxHeight
  );
  const fitsAt = (plotHeight, paneLegends, withShared = true) =>
    overflowOf(compose(plotHeight, paneLegends, withShared ? sharedLegend : null)) <= 1 + GROWTH_EPSILON;
  // The largest whole plot height whose composition fits the box, or the
  // least readable one. A taller plot makes every panel, axis margin and
  // legend beside it no smaller, so the fitting heights are found by halving.
  const largestFitting = (paneLegends, withShared = true) => {
    const fits = (plotHeight) => fitsAt(plotHeight, paneLegends, withShared);
    let low = minPlotHeight;
    if (!fits(low)) return low;
    let high = Math.max(low, boxHeight);
    if (fits(high)) return high;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (fits(middle)) low = middle;
      else high = middle;
    }
    return low;
  };

  // The plot height the box gives the panels without legends.
  const bareHeight = largestFitting(views.map(() => null), false);

  /** @type {Array<GridLegendSpec|null>} */
  let paneLegends = views.map(() => null);
  if (includeLegend && sharedLegend === null) {
    const own = views.map((view, index) => {
      const model = view.scientificState.legendModel ?? null;
      const highlight = highlightOf(index);
      const vectorKey = vectorKeyOf(index);
      return model === null && highlight === null && vectorKey === null
        ? null
        : { model, fieldKey: model === null ? null : view.scientificState.fieldKey, highlight, vectorKey };
    });
    const sided = side => own.map(legend => (legend === null ? null : { ...legend, side }));
    if (legendPosition === 'right') {
      // Each legend beside its plot unless, beside the plot the grid has
      // without legends, it would be wider than that plot; else every legend
      // beside; else every legend below: the first arrangement that keeps to
      // the box (`arrangementOf`). Decided against the legend-free plot
      // alone, a legend kept beside a plot that the legends then shrank was
      // planned again beside the shorter plot in more columns: two panels of
      // a wide view in an 800 × 600 box became 182 × 114 strips beside
      // 862 px legends, in a figure 1550 px wide (F113).
      const mixed = own.map((legend, index) => {
        if (legend === null) return null;
        const beside = planLegend({
          model: legend.model,
          fieldKey: legend.fieldKey,
          fontPx: legendFontPx,
          measureText: measure,
          placement: 'beside',
          extentPx: bareHeight,
          minWidth: PANEL_LEGEND_MIN_WIDTH,
          highlight: legend.highlight,
          vectorKey: legend.vectorKey,
        });
        return { ...legend, side: beside.width <= bareHeight * plotAspects[index] ? 'right' : 'below' };
      });
      paneLegends = arrangementOf([mixed, sided('right'), sided('below')]);
    } else {
      paneLegends = sided('below');
    }
  }

  /** The plot height an arrangement of the panel legends is drawn at: what fits, else the legends' share of the bare height. */
  function heightFor(arrangement) {
    return Math.max(
      largestFitting(arrangement),
      Math.min(bareHeight, Math.ceil(bareHeight * PANEL_LEGEND_SHARE - GROWTH_EPSILON)),
      minPlotHeight
    );
  }

  /**
   * Of arrangements of the panel legends, in the order preferred, the first
   * whose composition keeps to the box (its plots no shorter than the
   * legends' share of the bare height: `heightFor`); when none does, the one
   * reaching least past the box, then the one with the tallest plots.
   */
  function arrangementOf(arrangements) {
    let best = null;
    for (const arrangement of arrangements) {
      const plotHeight = heightFor(arrangement);
      const overflow = Math.max(1, overflowOf(compose(plotHeight, arrangement)));
      if (overflow <= 1 + GROWTH_EPSILON) return arrangement;
      const better = best === null
        || overflow < best.overflow - GROWTH_EPSILON
        || (Math.abs(overflow - best.overflow) <= GROWTH_EPSILON && plotHeight > best.plotHeight);
      if (better) best = { arrangement, plotHeight, overflow };
    }
    return best.arrangement;
  }

  const chosenHeight = heightFor(paneLegends);
  const grid = compose(chosenHeight, paneLegends);
  const { plotHeight } = grid;
  const { padding, header } = metrics;

  const colLefts = [];
  let x = contentX;
  for (const colWidth of grid.colWidths) {
    colLefts.push(x);
    x += colWidth;
  }
  const rowTops = [];
  let y = contentY;
  for (const rowHeight of grid.rowHeights) {
    rowTops.push(y);
    y += rowHeight;
  }

  /** @type {GridPaneLayout[]} */
  const panes = views.map((view, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const cellX = colLefts[col];
    const cellY = rowTops[row];
    const plotWidth = plotHeight * plotAspects[index];
    const plotsLeft = cellX + padding + grid.colAxisLeft[col];
    const plotRect = {
      x: plotsLeft + (grid.colPlotWidth[col] - plotWidth) / 2,
      y: cellY + padding + header + grid.rowAxisTop[row],
      width: plotWidth,
      height: plotHeight,
    };
    const legend = paneLegends[index];
    const plan = grid.plans[index];
    /** @type {Rect|null} */
    let legendRect = null;
    if (legend !== null && legend.side === 'right') {
      legendRect = {
        x: plotsLeft + grid.colPlotWidth[col] + grid.colAxisRight[col] + PANEL_LEGEND_GAP,
        y: plotRect.y,
        width: plan.width,
        height: plan.height,
      };
    } else if (legend !== null) {
      legendRect = {
        x: cellX + padding,
        y: plotRect.y + plotHeight + grid.rowAxisBottom[row] + PANEL_LEGEND_GAP,
        width: plan.width,
        height: plan.height,
      };
    }
    return {
      legendModel: legend?.model ?? null,
      legendFieldKey: legend?.fieldKey ?? null,
      legendPlan: legend === null ? null : plan,
      legendSide: legend?.side ?? null,
      labelX: plotRect.x,
      labelY: cellY + padding + Math.min(fontSize, header),
      panelRect: {
        x: cellX + 1,
        y: cellY + 1,
        width: grid.colWidths[col] - 2,
        height: grid.rowHeights[row] - 2,
      },
      plotRect,
      axes: grid.axes[index],
      legendRect,
      // Its vector field's key is rows of its legend or the shared one; else its plot draws it.
      vectorKeyInLegend: vectorKeyOf(index) !== null
        && ((legend !== null && legend.vectorKey !== null) || (sharedLegend !== null && sharedLegend.vectorKey !== null)),
    };
  });

  /** @type {Rect|null} */
  let sharedLegendRect = null;
  if (grid.sharedPlan !== null) {
    sharedLegendRect = legendPosition === 'right'
      ? {
        x: contentX + grid.gridWidth + LEGEND_GAP,
        y: contentY + padding + header + grid.rowAxisTop[0],
        width: grid.sharedPlan.width,
        height: grid.sharedPlan.height,
      }
      : {
        x: contentX + padding,
        y: contentY + grid.gridHeight + LEGEND_GAP,
        width: grid.sharedPlan.width,
        height: grid.sharedPlan.height,
      };
  }

  const titleWidth = hasTitle ? measure(titleText, titleFontPx) : 0;
  const totalWidth = Math.ceil(Math.max(contentX + grid.contentWidth, OUTER_PADDING + titleWidth) + OUTER_PADDING - GROWTH_EPSILON);
  const totalHeight = Math.ceil(contentY + grid.contentHeight + OUTER_PADDING - GROWTH_EPSILON);

  return {
    outerPadding: OUTER_PADDING,
    totalWidth,
    totalHeight,
    plotHeight,
    titleFontPx,
    titleRect: hasTitle
      ? { x: OUTER_PADDING, y: OUTER_PADDING, width: totalWidth - OUTER_PADDING * 2, height: TITLE_HEIGHT }
      : null,
    sharedLegend,
    sharedLegendRect,
    sharedLegendPlan: grid.sharedPlan,
    panes,
  };
}

// ============================================================================
// Export payload
// ============================================================================

/**
 * The layout of an export payload's figure, as both renderers draw it: the
 * single-view layout for one view (`single`), the grid for several (`grid`).
 * Everything it lays out is read from the payload here — each panel's axes
 * (the Axes choice, for a view that has them, showing the bounds its plot
 * frames: `computeSourceAxisBounds`), each panel's legend, and the
 * highlight's legend entry (`figureHighlightLegend`) — so the PNG and the SVG
 * of one payload are laid out by this one call and cannot place anything
 * differently.
 *
 * The payload's size is either a box (`width` × `height`, figure pixels: the
 * picture of a view) or a width the figure fills (`height: null`: the
 * Figure Export panel's physical width, `utils/figure-size.js`): the figure
 * is exactly `width` wide at its own height (`fillFigureWidth`).
 *
 * @param {any} payload - an export payload (`figure-export-contract.js`)
 * @param {{ includeLegend?: boolean }} [options] - `includeLegend: false` lays
 *   the figure out without its legends (the PNG's size refusal asks)
 * @returns {{ single: SingleViewLayout|null, grid: GridFigureLayout|null }}
 */
export function computeFigureLayout(payload, { includeLegend = payload.options.includeLegend } = {}) {
  const opts = payload.options;
  const views = payload.views;
  const crop = opts.crop;
  const hasAxes = figurePanelAxes(views, opts.includeAxes);
  /** @type {Array<AxesSpec|null>} */
  const panelAxes = views.map((view, index) => {
    if (!hasAxes[index]) return null;
    const bounds = computeSourceAxisBounds({
      renderState: view.renderState,
      crop,
      dimension: view.scientificState.dimensionLevel,
      cameraState: view.cameraState,
      normTransform: view.scientificState.normTransform,
    });
    return bounds === null ? null : {
      bounds,
      xLabel: opts.xLabel,
      yLabel: opts.yLabel,
      tickFontPx: opts.tickFontSizePx,
      labelFontPx: opts.axisLabelFontSizePx,
    };
  });
  const highlight = includeLegend ? figureHighlightLegend(payload) : null;
  // Each panel's vector field key, laid out with the legend (none without one).
  const vectorKeys = views.map(view => (includeLegend && view.data?.vectorField
    ? vectorFieldLegendKey(view.data.vectorField)
    : null));
  const plotAspects = views.map(view => figureSourceAspect({ renderState: view.renderState, crop }));
  const shared = {
    width: payload.width,
    height: payload.height,
    title: payload.title.trim(),
    titleFontSizePx: opts.titleFontSizePx,
    includeLegend,
    legendPosition: opts.legendPosition,
    legendFontSizePx: opts.legendFontSizePx,
    fontFamily: opts.fontFamily,
  };
  if (views.length === 1) {
    const scientific = views[0].scientificState;
    const single = {
      ...shared,
      plotAspect: plotAspects[0],
      axes: panelAxes[0],
      legendModel: includeLegend ? scientific.legendModel : null,
      legendFieldKey: includeLegend ? scientific.fieldKey : null,
      legendHighlight: highlight?.entry ?? null,
      legendVectorKey: vectorKeys[0],
    };
    return {
      single: payload.height === null ? fillSingleViewWidth(single) : computeSingleViewLayout(single),
      grid: null,
    };
  }
  const grid = {
    ...shared,
    columns: payload.gridColumns,
    views,
    plotAspects,
    panelAxes,
    legendHighlight: highlight,
    legendVectorKeys: vectorKeys,
    fontSize: opts.fontSizePx,
  };
  return {
    single: null,
    grid: payload.height === null ? fillGridWidth(grid) : computeGridFigureLayout(grid),
  };
}

// ============================================================================
// A width the figure fills
// ============================================================================

/**
 * A layout widened to `width`: the room a figure's composition leaves (a
 * plot grows by whole pixels, a grid row by its panels' aspects) goes to
 * its right margin, so the figure is exactly as wide as asked. A layout
 * already wider (its plots' least readable size, a title, a legend need it)
 * is left as it is.
 */
function widenTo(layout, width) {
  if (layout.totalWidth >= width) return layout;
  return {
    ...layout,
    totalWidth: width,
    titleRect: layout.titleRect === null ? null : { ...layout.titleRect, width: width - layout.outerPadding * 2 },
  };
}

/**
 * The single-view figure exactly `width` figure pixels wide: the widest plot
 * (of its view's aspect) whose figure — axes, legend, title around it — is no
 * wider, widened to `width` (`widenTo`). Its height is its own.
 *
 * The figure's width is the plot's plus what stands around it, and that rest
 * never shrinks as the plot narrows (a shorter plot holds fewer legend rows
 * beside it, so its legend takes more columns). So from the plot as wide as
 * the figure, each step narrows the plot by what the figure is too wide: it
 * never steps past the widest plot that fits, and reaches it in a few
 * layouts. Where no plot of a readable width (`PANEL_PLOT_MIN_WIDTH`) fits
 * (a long legend beside a short plot in a single column), the narrowest
 * figure with a readable plot is drawn, wider than asked (the export picture
 * says so).
 *
 * A legend asked beside the plot that would make the figure wider than asked
 * stands below it instead when that keeps the figure narrower, as a grid's
 * legends do (`arrangementOf`): a single column with a legend of long names
 * or the vector field's key beside a short plot came out 101 mm wide.
 * `legendMovedBelow` says so.
 *
 * @param {Parameters<typeof computeSingleViewLayout>[0]} options - `width`:
 *   the figure's width; `height` is not read
 * @returns {SingleViewLayout & {legendMovedBelow: boolean}}
 */
export function fillSingleViewWidth(options) {
  const asked = fillWithLegendAsAsked(options);
  if (asked.totalWidth <= Math.round(options.width) || options.legendPosition !== 'right' || asked.legendRect === null) {
    return { ...asked, legendMovedBelow: false };
  }
  const below = fillWithLegendAsAsked({ ...options, legendPosition: 'bottom' });
  return below.totalWidth < asked.totalWidth ? { ...below, legendMovedBelow: true } : { ...asked, legendMovedBelow: false };
}

/** `fillSingleViewWidth` with the legend where it is asked. */
function fillWithLegendAsAsked(options) {
  const width = Math.max(1, Math.round(options.width));
  const aspect = options.plotAspect;
  const least = Math.min(PANEL_PLOT_MIN_WIDTH, width);
  // A box as tall as the plot of its width: the plot is the box's width.
  const at = plotWidth => computeSingleViewLayout({
    ...options,
    width: plotWidth,
    height: Math.max(1, Math.ceil(plotWidth / aspect)),
  });
  let plotWidth = width;
  for (;;) {
    const laid = at(plotWidth);
    const over = laid.totalWidth - width;
    if (over <= 0) return widenTo(laid, width);
    const next = Math.min(plotWidth - 1, plotWidth - over);
    if (next < least) break;
    plotWidth = next;
  }
  // Nothing readable fits: of readable plots (the least, and growing by a
  // quarter to the width), the one whose figure is narrowest.
  let best = null;
  for (let candidate = least; ; candidate = Math.min(width, Math.ceil(candidate * 1.25))) {
    const laid = at(candidate);
    if (best === null || laid.totalWidth < best.totalWidth) best = laid;
    if (candidate >= width) break;
  }
  return best;
}

/**
 * The grid figure exactly `width` figure pixels wide: the grid composed in a
 * box of that width with no height to keep to (`computeGridFigureLayout`
 * then finds the tallest plots whose composition is no wider), widened to
 * `width` (`widenTo`). Its height is its own.
 *
 * @param {Parameters<typeof computeGridFigureLayout>[0]} options - `width`:
 *   the figure's width; `height` is not read
 * @returns {GridFigureLayout}
 */
export function fillGridWidth(options) {
  const width = Math.max(1, Math.round(options.width));
  // No height to keep to: one the plots cannot reach at this width (the
  // narrowest plot aspect gives the tallest plot a width allows).
  const tallest = Math.ceil(width / Math.min(...options.plotAspects)) * Math.max(1, options.views.length);
  return widenTo(computeGridFigureLayout({ ...options, height: tallest + width }), width);
}
