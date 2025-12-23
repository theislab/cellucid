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
import { getScatterTraceType } from '../plotly-loader.js';
import { getFiniteMinMax, isFiniteNumber, mean } from '../../shared/number-utils.js';
import { applyLegendPosition } from '../../shared/legend-utils.js';
import { getPlotTheme } from '../../shared/plot-theme.js';
import { generateCategoryColors } from '../../shared/color-utils.js';
import { escapeHtml } from '../../../utils/dom-utils.js';

const scatterPlotDefinition = {
  id: 'scatterplot',
  name: 'Scatter Plot',
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
    const annotations = [];
    const theme = getPlotTheme();

    // Determine if we should show density instead of points
    const totalPoints = pageResults.reduce((sum, pr) => sum + (pr.xValues?.length || 0), 0);
    const useDensity = showDensity || totalPoints > densityThreshold;

    for (let i = 0; i < pageResults.length; i++) {
      const pageResult = pageResults[i];

      if (!pageResult.xValues || !pageResult.yValues) continue;

      const color = BasePlot.getPageColor(layoutEngine, pageResult.pageId, i);
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
          name: pageResult.pageName,
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

        // Add sparse scatter points on top (GPU-accelerated)
        const sampleSize = Math.min(500, xData.length);
        const step = Math.max(1, Math.floor(xData.length / sampleSize));
        const sampledX = [];
        const sampledY = [];
        for (let j = 0; j < xData.length; j += step) {
          sampledX.push(xData[j]);
          sampledY.push(yData[j]);
        }

        traces.push({
          type: getScatterTraceType(),
          mode: 'markers',
          name: pageResult.pageName,
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
        const categoryColors = generateCategoryColors(categories, theme);

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

          traces.push({
            type: getScatterTraceType(),
            mode: 'markers',
            name: cat,
            legendgroup: cat,
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
        }
      } else {
        // Regular scatter plot (GPU-accelerated)
        traces.push({
          type: getScatterTraceType(),
          mode: 'markers',
          name: pageResult.pageName,
          x: xData,
          y: yData,
          marker: {
            color: color,
            size: pointSize,
            opacity: pointOpacity,
            line: { width: 0 }
          },
          hovertemplate: `${escapeHtml(pageResult.pageName)}<br>` +
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
          type: getScatterTraceType(),
          mode: 'lines',
          name: `Trend (${pageResult.pageName})`,
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
            type: getScatterTraceType(),
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

        annotations.push({
          text: `<b>${escapeHtml(pageResult.pageName ?? '')}</b><br>` +
                `R² = ${rSquared.toFixed(3)}${significance}<br>` +
                `r = ${pageResult.r.toFixed(3)}<br>` +
                `n = ${xData.length}`,
          x: 0.02,
          y: 0.98 - i * 0.15,
          xref: 'paper',
          yref: 'paper',
          xanchor: 'left',
          yanchor: 'top',
          showarrow: false,
          font: {
            family: theme.fontFamily,
            size: 10,
            color: color
          },
          bgcolor: theme.legend.bg,
          borderpad: 4,
          bordercolor: color,
          borderwidth: 1
        });
      }
    }

    // Build layout using BasePlot utility
    const layout = BasePlot.createLayout({
      showLegend: pageResults.length > 1
    });

    // Get variable names from first result
    const xVariable = pageResults[0]?.xVariable || 'Variable X';
    const yVariable = pageResults[0]?.yVariable || 'Variable Y';

    layout.xaxis = {
      title: {
        text: xVariable,
        font: { family: 'Oswald, system-ui, sans-serif', size: 12, color: theme.text }
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
        font: { family: 'Oswald, system-ui, sans-serif', size: 12, color: theme.text }
      },
      type: logScaleY ? 'log' : 'linear',
      showgrid: showGrid,
      gridcolor: theme.grid,
      zeroline: false,
      tickfont: { size: 10, color: theme.textMuted }
    };

    layout.annotations = annotations;

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

    layout.margin = { l: 60, r: 20, t: 30, b: 50 };
    applyLegendPosition(layout, options.legendPosition);

    // Render with Plotly
    const config = getPlotlyConfig();
    config.scrollZoom = true;

    try {
      const Plotly = await createMinimalPlotly();
      return await Plotly.newPlot(container, traces, layout, config);
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
    // For scatter plots with complex trace manipulation, a full re-render is often cleaner.
    // Purge first to avoid leaking WebGL contexts / DOM on repeated updates.
    try {
      const Plotly = await createMinimalPlotly();
      Plotly.purge?.(figure);
    } catch (_purgeErr) {
      // Ignore purge failures
    }

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
