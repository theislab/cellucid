/**
 * Scatter Plot for Correlation Analysis
 *
 * Visualizes correlation between two continuous variables:
 * - Points colored by page
 * - Optional trend lines with regression
 * - R² and correlation statistics
 * - Density contours for large datasets
 * Refactored to use BasePlot utilities for consistency.
 */

import { PlotRegistry, BasePlot, COMMON_HOVER_STYLE, createMinimalPlotly, getPlotlyConfig } from '../plot-factory.js';
import { PLOTLY_2D_SCATTER_TRACE_TYPE } from '../plotly-loader.js';
import { getFiniteMinMax, isFiniteNumber, mean } from '../../shared/number-utils.js';
import { applyLegendPosition } from '../../shared/legend-utils.js';
import { getPlotTheme } from '../../shared/plot-theme.js';
import { generateCategoryColors } from '../../shared/color-utils.js';
import { escapeHtml } from '../../../utils/dom-utils.js';
import { textHeight, textWidth } from '../text-measure.js';
import { fitToSize } from '../size-fit.js';

/** The statistics boxes' text and frame, in px. */
const STATS_FONT_SIZE = 10;
const STATS_BORDER_PAD = 4;
const STATS_BORDER_WIDTH = 1;
/** Room between two boxes, and between a box and the legend. */
const STATS_GAP = 6;
/** The plot's margins (`layout.margin`). */
const SCATTER_MARGIN = Object.freeze({ l: 60, r: 20, t: 30, b: 50 });
/** Plotly's vertical legend: each entry's height, and what a legend adds to its text. */
const LEGEND_ENTRY_HEIGHT = 19;
const LEGEND_FRAME_HEIGHT = 11;
const LEGEND_FRAME_WIDTH = 52;
const LEGEND_FONT_SIZE = 10;

/** Width and height of one framed annotation of `lines`, in px. */
function framedSize(lines, theme) {
  const width = Math.max(...lines.map(line => textWidth(line.text, {
    size: STATS_FONT_SIZE, family: theme.fontFamily, weight: line.bold ? 'bold' : 'normal'
  })));
  const frame = 2 * (STATS_BORDER_PAD + STATS_BORDER_WIDTH);
  return { width: Math.ceil(width) + frame, height: Math.ceil(textHeight(lines.length, STATS_FONT_SIZE)) + frame };
}

/**
 * Where the legend sits in the plot area, as a box in px from its top-left,
 * or null when it is outside it or not drawn.
 */
function legendBox(layout, entries, plotWidth, plotHeight) {
  if (layout.showlegend !== true || entries.length === 0) return null;
  const legend = layout.legend ?? {};
  if (legend.orientation === 'h' || legend.x > 1 || legend.x < 0 || legend.y > 1 || legend.y < 0) return null;
  const width = Math.max(...entries.map(name => textWidth(name, { size: LEGEND_FONT_SIZE, family: getPlotTheme().fontFamily })))
    + LEGEND_FRAME_WIDTH;
  // Plotly scrolls a legend taller than the plot area within it.
  const height = Math.min(plotHeight, LEGEND_FRAME_HEIGHT + entries.length * LEGEND_ENTRY_HEIGHT);
  const left = legend.xanchor === 'right' ? plotWidth - width : legend.xanchor === 'center' ? (plotWidth - width) / 2 : 0;
  const top = legend.yanchor === 'top' ? 0 : legend.yanchor === 'bottom' ? plotHeight - height : (plotHeight - height) / 2;
  return { left, top, right: left + width, bottom: top + height };
}

function boxesMeet(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * Lay out the statistics of each page in the plot area, in px, so that no
 * box lands on another or on the legend at any size of the plot: one box per
 * page, stacked in the top corner the legend leaves free, else side by side,
 * else one compact box of R² values (each in its page's color). When none
 * of them fits beside an automatic legend, the legend gives way (it is
 * dropped only from the automatic placement, as the volcano plot's is);
 * where not even the compact box fits, the statistics are left to the
 * expanded view and its table.
 *
 * @param {Array<{color: string, lines: Array<{text: string, bold?: boolean}>, compact: string}>} stats
 * @param {Object} layout - The finished layout; `showlegend` may be turned off
 * @param {string[]} legendEntries - The names the legend lists
 * @param {{width: number, height: number}} viewport
 * @param {boolean} legendIsAutomatic
 * @returns {Object[]} The annotations
 */
function placeStatistics(stats, layout, legendEntries, viewport, legendIsAutomatic) {
  if (stats.length === 0) return [];
  if (!(viewport.width > 0) || !(viewport.height > 0)) {
    throw new RangeError('Scatter plot container must have a positive size to place its statistics');
  }
  const theme = getPlotTheme();
  const plotWidth = viewport.width - SCATTER_MARGIN.l - SCATTER_MARGIN.r;
  const plotHeight = viewport.height - SCATTER_MARGIN.t - SCATTER_MARGIN.b;
  const sizes = stats.map(entry => framedSize(entry.lines, theme));
  const boxAnnotation = (entry, size, left, top) => ({
    text: entry.lines.map(line => (line.bold ? `<b>${line.text}</b>` : line.text)).join('<br>'),
    x: 0, y: 1, xref: 'paper', yref: 'paper', xanchor: 'left', yanchor: 'top',
    xshift: left, yshift: -top,
    align: 'left',
    showarrow: false,
    font: { family: theme.fontFamily, size: STATS_FONT_SIZE, color: entry.color },
    bgcolor: theme.legend.bg,
    borderpad: STATS_BORDER_PAD,
    bordercolor: entry.color,
    borderwidth: STATS_BORDER_WIDTH
  });
  const arrangements = () => {
    const legend = legendBox(layout, legendEntries, plotWidth, plotHeight);
    // The top corner away from a legend on the left.
    const fromRight = legend !== null && legend.left === 0 && legend.right < plotWidth;
    const at = (left, width) => (fromRight ? plotWidth - left - width : left);
    const fits = boxes => boxes.every(box => (
      box.left >= 0 && box.top >= 0 && box.right <= plotWidth && box.bottom <= plotHeight &&
      (legend === null || !boxesMeet(box, {
        left: legend.left - STATS_GAP, right: legend.right + STATS_GAP, top: legend.top - STATS_GAP, bottom: legend.bottom + STATS_GAP
      }))
    ));
    const placed = [];
    // One column of boxes.
    let top = 0;
    const column = sizes.map(size => {
      const left = at(0, size.width);
      const box = { left, top, right: left + size.width, bottom: top + size.height };
      top += size.height + STATS_GAP;
      return box;
    });
    placed.push(column);
    // One row of boxes.
    let left = 0;
    placed.push(sizes.map(size => {
      const boxLeft = at(left, size.width);
      left += size.width + STATS_GAP;
      return { left: boxLeft, top: 0, right: boxLeft + size.width, bottom: size.height };
    }));
    for (const boxes of placed) {
      if (fits(boxes)) return stats.map((entry, index) => boxAnnotation(entry, sizes[index], boxes[index].left, boxes[index].top));
    }
    // One compact box: each page's R² in its color.
    const compactLines = stats.map(entry => ({ text: entry.compact }));
    const compact = framedSize(compactLines, theme);
    const compactLeft = at(0, compact.width);
    if (fits([{ left: compactLeft, top: 0, right: compactLeft + compact.width, bottom: compact.height }])) {
      return [{
        ...boxAnnotation({ lines: compactLines, color: theme.legend.border }, compact, compactLeft, 0),
        text: stats.map(entry => `<span style="color:${entry.color}">${entry.compact}</span>`).join('<br>'),
        font: { family: theme.fontFamily, size: STATS_FONT_SIZE, color: theme.text }
      }];
    }
    return null;
  };
  let annotations = arrangements();
  if (annotations === null && legendIsAutomatic && layout.showlegend === true) {
    layout.showlegend = false;
    annotations = arrangements();
  }
  return annotations ?? [];
}

// Correlation plots use Plotly's SVG Cartesian trace in every browser. The main
// Cellucid renderer owns the page's WebGL context; Plotly must not allocate a
// second context or replace scientific output with its WebGL-failure overlay.
const scatterPlotDefinition = {
  id: 'scatterplot',
  name: 'Scatter plot',
  description: 'Correlation between two continuous variables',
  supportedTypes: ['correlation', 'continuous_pair'],
  supportedLayouts: ['overlay', 'side-by-side'],

  defaultOptions: {
    showTrendline: true,
    showR2: true,
    showConfidenceInterval: false,
    pointSize: 5,
    pointOpacity: 0.6,
    colorByPage: true,
    showDensity: false,
    densityThreshold: 1000,
    logScaleX: false,
    logScaleY: false,
    showGrid: true
  },

  optionSchema: {
    showTrendline: {
      type: 'checkbox',
      label: 'Show trend line'
    },
    showR2: {
      type: 'checkbox',
      label: 'Show R² statistics'
    },
    showConfidenceInterval: {
      type: 'checkbox',
      label: 'Show 95% CI',
      showWhen: (opts) => opts.showTrendline
    },
    pointSize: {
      type: 'range',
      label: 'Point size',
      min: 2,
      max: 12,
      step: 1
    },
    pointOpacity: {
      type: 'range',
      label: 'Point opacity',
      min: 0.1,
      max: 1,
      step: 0.1
    },
    showDensity: {
      type: 'checkbox',
      label: 'Show density contours'
    },
    logScaleX: {
      type: 'checkbox',
      label: 'Log scale X'
    },
    logScaleY: {
      type: 'checkbox',
      label: 'Log scale Y'
    },
    showGrid: {
      type: 'checkbox',
      label: 'Show grid'
    }
  },

  /**
   * Render scatter plot
   * @param {Object[]} correlationData - Array of correlation results per page
   * @param {Object} options - Plot options
   * @param {HTMLElement} container - Container element
   * @param {LayoutEngine} layoutEngine - Layout engine instance
   * @returns {Promise<Object>} Plotly figure reference
   */
  async render(correlationData, options, container, layoutEngine) {
    const {
      showTrendline = true,
      showR2 = true,
      showConfidenceInterval = false,
      pointSize = 5,
      pointOpacity = 0.6,
      showDensity = false,
      densityThreshold = 1000,
      logScaleX = false,
      logScaleY = false,
      showGrid = true
    } = options;

    // Handle different input formats
    const pageResults = Array.isArray(correlationData) ? correlationData : [correlationData];

    if (pageResults.length === 0 || !pageResults[0].xValues) {
      const theme = getPlotTheme();
      // Show empty state
      const layout = BasePlot.createLayout({ showLegend: false });
      layout.annotations = [{
        text: 'No correlation data available',
        x: 0.5,
        y: 0.5,
        xref: 'paper',
        yref: 'paper',
        showarrow: false,
        font: { size: 14, color: theme.textMuted }
      }];
      const Plotly = await createMinimalPlotly();
      return Plotly.newPlot(container, [], layout, getPlotlyConfig());
    }

    const traces = [];
    const stats = [];
    const theme = getPlotTheme();
    // One color per category across every page, and one legend entry each.
    const allCategories = new Set();
    for (const pageResult of pageResults) {
      if (pageResult.colorValues && pageResult.colorValues.length > 0 && pageResult.colorVariable) {
        for (const value of pageResult.colorValues) allCategories.add(value ?? 'Unknown');
      }
    }
    const sharedCategoryColors = generateCategoryColors([...allCategories].filter(c => c != null).sort(), theme);
    const listedCategories = new Set();

    // Determine if we should show density instead of points
    const totalPoints = pageResults.reduce((sum, pr) => sum + (pr.xValues?.length || 0), 0);
    const useDensity = showDensity || totalPoints > densityThreshold;

    for (let i = 0; i < pageResults.length; i++) {
      const pageResult = pageResults[i];

      if (!pageResult.xValues || !pageResult.yValues) continue;

      const color = BasePlot.getPageColor(layoutEngine, pageResult.pageId, i);
      // Trace names reach the legend and hover box, both of which Plotly parses
      // for its HTML subset. Page names are user/session supplied.
      const safePageName = escapeHtml(pageResult.pageName ?? '');
      const xVals = pageResult.xValues;
      const yVals = pageResult.yValues;

      // Filter to valid pairs for display (avoid allocating per-point objects)
      const xData = [];
      const yData = [];
      for (let j = 0; j < Math.min(xVals.length, yVals.length); j++) {
        const x = xVals[j];
        const y = yVals[j];
        if (isFiniteNumber(x) && isFiniteNumber(y)) {
          // Handle log scale - skip non-positive values
          if ((logScaleX && x <= 0) || (logScaleY && y <= 0)) continue;
          xData.push(x);
          yData.push(y);
        }
      }

      if (xData.length === 0) continue;

      // Check if we have colorBy data
      const hasColorBy = pageResult.colorValues && pageResult.colorValues.length > 0 && pageResult.colorVariable;
      // Get aligned color data (must match xData/yData after filtering)
      let colorData = null;
      if (hasColorBy) {
        const colorVals = pageResult.colorValues;
        colorData = [];
        for (let j = 0; j < Math.min(xVals.length, yVals.length); j++) {
          const x = xVals[j];
          const y = yVals[j];
          if (isFiniteNumber(x) && isFiniteNumber(y)) {
            if ((logScaleX && x <= 0) || (logScaleY && y <= 0)) continue;
            colorData.push(colorVals[j] ?? 'Unknown');
          }
        }
      }

      if (useDensity && xData.length > densityThreshold && !hasColorBy) {
        // Use density plot for large datasets (only when not coloring by category)
            traces.push({
          type: 'histogram2dcontour',
          name: safePageName,
          x: xData,
          y: yData,
          colorscale: [[0, 'rgba(255,255,255,0)'], [1, color]],
          showscale: false,
          contours: {
            showlines: false
          },
          ncontours: 10,
          hoverinfo: 'none'
        });

        // Add sparse SVG scatter points on top of the density layer.
        const sampleSize = Math.min(500, xData.length);
        const step = Math.max(1, Math.floor(xData.length / sampleSize));
        const sampledX = [];
        const sampledY = [];
        for (let j = 0; j < xData.length; j += step) {
          sampledX.push(xData[j]);
          sampledY.push(yData[j]);
        }

        traces.push({
          type: PLOTLY_2D_SCATTER_TRACE_TYPE,
          mode: 'markers',
          name: safePageName,
          x: sampledX,
          y: sampledY,
          showlegend: false,
          marker: {
            color: color,
            size: pointSize * 0.8,
            opacity: pointOpacity * 0.5,
            line: { width: 0 }
          },
          hoverinfo: 'x+y'
        });
      } else if (hasColorBy && colorData) {
        // Color by categorical variable - create separate trace per category
        const categories = [...new Set(colorData)].filter(c => c != null).sort();
        const categoryColors = sharedCategoryColors;

        for (const cat of categories) {
          const catX = [];
          const catY = [];
          for (let j = 0; j < xData.length; j++) {
            if (colorData[j] === cat) {
              catX.push(xData[j]);
              catY.push(yData[j]);
            }
          }

          if (catX.length === 0) continue;
          const firstOfCategory = !listedCategories.has(cat);

          traces.push({
            type: PLOTLY_2D_SCATTER_TRACE_TYPE,
            mode: 'markers',
            // Rendered in the legend; `legendgroup` is an internal grouping key
            // that Plotly never draws, so it keeps the raw value.
            name: escapeHtml(cat),
            legendgroup: cat,
            showlegend: firstOfCategory,
            x: catX,
            y: catY,
              marker: {
                color: categoryColors.get(cat) || color,
                size: pointSize,
                opacity: pointOpacity,
                line: { width: 0 }
              },
            hovertemplate: `${escapeHtml(pageResult.xVariable || 'X')}: %{x:.2f}<br>` +
              `${escapeHtml(pageResult.yVariable || 'Y')}: %{y:.2f}<br>` +
              `${escapeHtml(pageResult.colorVariable)}: ${escapeHtml(cat)}<extra></extra>`,
            hoverlabel: COMMON_HOVER_STYLE
          });
          listedCategories.add(cat);
        }
      } else {
        // Regular cross-browser SVG scatter plot.
        traces.push({
          type: PLOTLY_2D_SCATTER_TRACE_TYPE,
          mode: 'markers',
          name: safePageName,
          x: xData,
          y: yData,
          marker: {
            color: color,
            size: pointSize,
            opacity: pointOpacity,
            line: { width: 0 }
          },
          hovertemplate: `${safePageName}<br>` +
            `${escapeHtml(pageResult.xVariable || 'X')}: %{x:.2f}<br>` +
            `${escapeHtml(pageResult.yVariable || 'Y')}: %{y:.2f}<extra></extra>`,
          hoverlabel: COMMON_HOVER_STYLE
        });
      }

      // Add trend line if requested
      if (showTrendline && pageResult.slope !== undefined) {
        const { min: xMin, max: xMax } = getFiniteMinMax(xData);
        const xRange = [xMin, xMax];
        const yRange = xRange.map(x => pageResult.slope * x + pageResult.intercept);

        traces.push({
          type: PLOTLY_2D_SCATTER_TRACE_TYPE,
          mode: 'lines',
          name: `Trend (${safePageName})`,
          x: xRange,
          y: yRange,
          showlegend: false,
          line: {
            color: color,
            width: 2,
            dash: 'solid'
          },
          hoverinfo: 'none'
        });

        // Add confidence interval
        if (showConfidenceInterval) {
          const { ciLower, ciUpper } = computeConfidenceBand(xData, yData, pageResult.slope, pageResult.intercept);
          const xPoints = [];
          const nPoints = 50;
          for (let j = 0; j <= nPoints; j++) {
            xPoints.push(xMin + (xMax - xMin) * (j / nPoints));
          }

          // Upper bound
          const upperY = xPoints.map((x) => ciUpper(x));
          // Lower bound
          const lowerY = xPoints.map((x) => ciLower(x));

          traces.push({
            type: PLOTLY_2D_SCATTER_TRACE_TYPE,
            mode: 'lines',
            x: [...xPoints, ...xPoints.reverse()],
            y: [...upperY, ...lowerY.reverse()],
            fill: 'toself',
            fillcolor: color + '20',
            line: { width: 0 },
            showlegend: false,
            hoverinfo: 'none'
          });
        }
      }

      // Add R² annotation
      if (showR2 && pageResult.r !== undefined && Number.isFinite(pageResult.r)) {
        const rSquared = pageResult.rSquared !== undefined ? pageResult.rSquared : pageResult.r * pageResult.r;
        const pValue = pageResult.pValue;
        const significance = pValue < 0.001 ? '***' : pValue < 0.01 ? '**' : pValue < 0.05 ? '*' : '';

        stats.push({
          color,
          lines: [
            { text: safePageName, bold: true },
            { text: `R² = ${rSquared.toFixed(3)}${significance}` },
            { text: `r = ${pageResult.r.toFixed(3)}` },
            { text: `n = ${xData.length}` }
          ],
          compact: `R² = ${rSquared.toFixed(3)}${significance}`
        });
      }
    }

    // Build layout using BasePlot utility
    const layout = BasePlot.createLayout({
      showLegend: pageResults.length > 1
    });

    // Get variable names from first result. These are obs/var field names from
    // the dataset and axis titles are parsed for Plotly's HTML subset.
    const xVariable = escapeHtml(pageResults[0]?.xVariable || 'Variable X');
    const yVariable = escapeHtml(pageResults[0]?.yVariable || 'Variable Y');

    layout.xaxis = {
      title: {
        text: xVariable,
        font: { family: theme.fontFamily, size: 12, color: theme.text }
      },
      type: logScaleX ? 'log' : 'linear',
      showgrid: showGrid,
      gridcolor: theme.grid,
      zeroline: false,
      tickfont: { size: 10, color: theme.textMuted }
    };

    layout.yaxis = {
      title: {
        text: yVariable,
        font: { family: theme.fontFamily, size: 12, color: theme.text }
      },
      type: logScaleY ? 'log' : 'linear',
      showgrid: showGrid,
      gridcolor: theme.grid,
      zeroline: false,
      tickfont: { size: 10, color: theme.textMuted }
    };

    layout.legend = {
      x: 1,
      y: 1,
      xanchor: 'right',
      yanchor: 'top',
      bgcolor: theme.legend.bg,
      bordercolor: theme.legend.border,
      borderwidth: 1,
      font: { size: 10 }
    };

    layout.margin = { ...SCATTER_MARGIN };
    applyLegendPosition(layout, options.legendPosition);
    const legendEntries = traces
      .filter(trace => trace.showlegend !== false && trace.type !== 'histogram2dcontour')
      .map(trace => trace.name);
    const legendShown = layout.showlegend;
    // The statistics are placed for the size the plot is drawn at, and again
    // whenever it is resized (`size-fit.js`).
    const statisticsFor = element => {
      const sized = { ...layout, showlegend: legendShown };
      const annotations = placeStatistics(
        stats,
        sized,
        legendEntries,
        { width: element.clientWidth, height: element.clientHeight },
        (options.legendPosition ?? 'auto') === 'auto'
      );
      return { annotations, showlegend: sized.showlegend };
    };
    Object.assign(layout, statisticsFor(container));

    // Render with Plotly
    const config = getPlotlyConfig();
    config.scrollZoom = true;

    try {
      const Plotly = await createMinimalPlotly();
      const figure = await Plotly.newPlot(container, traces, layout, config);
      return fitToSize(figure, () => Plotly.relayout(figure, statisticsFor(figure)));
    } catch (err) {
      console.error('[ScatterPlot] Render error:', err);
      throw new Error(`Failed to render scatter plot: ${err.message}`);
    }
  },

  /**
   * Update existing plot using Plotly.react for efficient updates
   * @param {Object} figure - Existing Plotly figure
   * @param {Object[]} correlationData - Correlation data
   * @param {Object} options - Plot options
   * @param {LayoutEngine} layoutEngine - Layout engine instance
   * @returns {Promise<Object>} Updated Plotly figure
   */
  async update(figure, correlationData, _options, layoutEngine) {
    const Plotly = await createMinimalPlotly();
    if (typeof Plotly.purge !== 'function') {
      throw new TypeError('Scatter plot update requires Plotly.purge');
    }
    Plotly.purge(figure);

    return this.render(correlationData, _options, figure, layoutEngine);
  },

  /**
   * Export plot data as CSV
   * Exports correlation statistics and point data
   * @param {Object[]} correlationData - Correlation data
   * @param {Object} options - Plot options
   * @returns {Object} { rows, columns, metadata }
   */
  exportCSV(correlationData, options) {
    const pageResults = Array.isArray(correlationData) ? correlationData : [correlationData];
    const rows = [];

    // Summary statistics table
    const statsRows = [];
    const statsColumns = ['page', 'r', 'r_squared', 'p_value', 'slope', 'intercept', 'n'];

    for (const pr of pageResults) {
      if (!pr.xValues || !pr.yValues) continue;

      const rSquared = pr.rSquared !== undefined ? pr.rSquared : (pr.r ? pr.r * pr.r : null);
      statsRows.push({
        page: pr.pageName,
        r: pr.r?.toFixed(4) ?? 'N/A',
        r_squared: rSquared?.toFixed(4) ?? 'N/A',
        p_value: pr.pValue?.toExponential(3) ?? 'N/A',
        slope: pr.slope?.toFixed(4) ?? 'N/A',
        intercept: pr.intercept?.toFixed(4) ?? 'N/A',
        n: pr.xValues?.length || 0
      });
    }

    // Point data table
    const pointColumns = ['page', 'x', 'y', 'cell_index'];
    for (const pr of pageResults) {
      if (!pr.xValues || !pr.yValues) continue;

      for (let i = 0; i < Math.min(pr.xValues.length, pr.yValues.length); i++) {
        rows.push({
          page: pr.pageName,
          x: pr.xValues[i],
          y: pr.yValues[i],
          cell_index: pr.cellIndices?.[i] ?? i
        });
      }
    }

    return {
      rows,
      columns: pointColumns,
      summaryRows: statsRows,
      summaryColumns: statsColumns,
      metadata: {
        plotType: 'scatterplot',
        xVariable: pageResults[0]?.xVariable || 'X',
        yVariable: pageResults[0]?.yVariable || 'Y',
        pageCount: pageResults.length,
        exportDate: new Date().toISOString()
      }
    };
  }
};

/**
 * Compute confidence band for linear regression
 */
function computeConfidenceBand(xData, yData, slope, intercept, confidence = 0.95) {
  const n = xData.length;
  if (n < 3) {
    return {
      ciLower: () => NaN,
      ciUpper: () => NaN
    };
  }

  const xMean = mean(xData);
  const ssX = xData.reduce((a, b) => a + Math.pow(b - xMean, 2), 0);

  // Residual standard error
  const yPred = xData.map(x => slope * x + intercept);
  const residuals = yData.map((y, i) => y - yPred[i]);
  const sse = residuals.reduce((a, b) => a + b * b, 0);
  const se = Math.sqrt(sse / (n - 2));

  // t-value for confidence level (alpha unused but kept for documentation)
  const _alpha = 1 - confidence;
  const tValue = 1.96; // Approximation for 95% CI with large n

  return {
    ciLower: (x) => {
      const seY = se * Math.sqrt(1/n + Math.pow(x - xMean, 2) / ssX);
      return slope * x + intercept - tValue * seY;
    },
    ciUpper: (x) => {
      const seY = se * Math.sqrt(1/n + Math.pow(x - xMean, 2) / ssX);
      return slope * x + intercept + tValue * seY;
    }
  };
}

// Register the plot type
PlotRegistry.register(scatterPlotDefinition);

export default scatterPlotDefinition;
