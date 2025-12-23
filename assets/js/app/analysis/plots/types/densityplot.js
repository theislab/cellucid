/**
 * Density Plot Type
 *
 * Kernel density estimation for continuous variables.
 * Supports overlay mode for comparing multiple pages on the same axes.
 * Refactored to use PlotFactory for reduced code duplication.
 */

import { PlotFactory, PlotRegistry, BasePlot, COMMON_HOVER_STYLE } from '../plot-factory.js';
import { getScatterTraceType } from '../plotly-loader.js';
import { filterFiniteNumbers, getFiniteMinMax, mean, std } from '../../shared/number-utils.js';
import { escapeHtml } from '../../../utils/dom-utils.js';

/**
 * Simple kernel density estimation using Gaussian kernel
 * @param {number[]} data - Data points
 * @param {number} bandwidth - Kernel bandwidth (or 'auto')
 * @param {number} nPoints - Number of points for the output curve
 * @returns {Object} { x: number[], y: number[] }
 */
function kernelDensity(data, bandwidth = 'auto', nPoints = 100) {
  if (!data || data.length === 0) return { x: [], y: [] };

  const validData = filterFiniteNumbers(data);
  if (validData.length === 0) return { x: [], y: [] };

  const n = validData.length;
  const { min, max } = getFiniteMinMax(validData);
  const range = max - min;

  if (range === 0) return { x: [min], y: [1] };

  // Calculate bandwidth using Silverman's rule of thumb if auto
  let h = bandwidth;
  if (bandwidth === 'auto') {
    const stdVal = std(validData);
    h = 1.06 * stdVal * Math.pow(n, -0.2);
    if (h <= 0 || !Number.isFinite(h)) h = range / 10;
  }

  // Generate evaluation points
  const padding = h * 3;
  const x = [];
  const step = (range + 2 * padding) / (nPoints - 1);
  for (let i = 0; i < nPoints; i++) x.push(min - padding + i * step);

  // Evaluate density at each point (Gaussian kernel)
  const y = x.map(xi => {
    let sum = 0;
    for (const d of validData) {
      const u = (xi - d) / h;
      sum += Math.exp(-0.5 * u * u) / Math.sqrt(2 * Math.PI);
    }
    return sum / (n * h);
  });

  return { x, y };
}

/**
 * Get bandwidth multiplier from option
 */
function getBandwidthMultiplier(bandwidth) {
  if (bandwidth === 'narrow') return 0.5;
  if (bandwidth === 'wide') return 2;
  return 1;
}

/**
 * Calculate density curve for data with bandwidth multiplier
 */
function calculateDensity(values, bandwidthMult) {
  let { x, y } = kernelDensity(values, 'auto');
  if (bandwidthMult !== 1 && values.length > 0) {
    const stdVal = std(values);
    const h = 1.06 * stdVal * Math.pow(values.length, -0.2) * bandwidthMult;
    const recalc = kernelDensity(values, h);
    x = recalc.x;
    y = recalc.y;
  }
  return { x, y };
}

const densityplotDefinition = {
  id: 'densityplot',
  name: 'Density Plot',
  description: 'Smoothed distribution curve',
  supportedTypes: ['continuous'],
  supportedLayouts: ['overlay', 'side-by-side'],

  defaultOptions: {
    fillOpacity: 30,
    bandwidth: 'auto',
    showMean: true,
    logX: false,
    logY: false
  },

  optionSchema: {
    fillOpacity: { type: 'range', label: 'Fill', min: 0, max: 100, step: 10 },
    bandwidth: {
      type: 'select',
      label: 'Bandwidth',
      options: [
        { value: 'auto', label: 'Auto' },
        { value: 'narrow', label: 'Narrow' },
        { value: 'wide', label: 'Wide' }
      ]
    },
    logX: { type: 'checkbox', label: 'Log X' },
    logY: { type: 'checkbox', label: 'Log Y' },
    showMean: { type: 'checkbox', label: 'Mean line' }
  },

  buildTraces(pageData, options, layoutEngine) {
    const bandwidthMult = getBandwidthMultiplier(options.bandwidth);
    const fillOpacity = (options.fillOpacity || 30) / 100;

    return PlotFactory.createTraces({
      pageData, options, layoutEngine, filterNumeric: true, minValues: 1,
      traceBuilder: (pd, color, _i, _opts) => {
        const { x, y } = calculateDensity(pd.values, bandwidthMult);
        if (x.length === 0) return null;

        // GPU-accelerated density curve
        return {
          type: getScatterTraceType(),
          mode: 'lines',
          x, y,
          name: pd.pageName,
          line: { color, width: 2, shape: 'spline' },
          fill: 'tozeroy',
          fillcolor: PlotFactory.hexToRgba(color, fillOpacity),
          hovertemplate: `${escapeHtml(pd.pageName)}<br>Value: %{x:.2f}<br>Density: %{y:.4f}<extra></extra>`,
          hoverlabel: COMMON_HOVER_STYLE
        };
      }
    });
  },

  buildLayout(pageData, options, layoutEngine) {
    const layout = PlotFactory.createLayout({ pageData, options });
    const variableName = BasePlot.getVariableName(pageData, 'Value');

    layout.xaxis = { title: variableName, automargin: true, type: options.logX ? 'log' : 'linear' };
    layout.yaxis = { title: 'Density', zeroline: true, rangemode: 'tozero', type: options.logY ? 'log' : 'linear' };

    // Add mean lines as shapes
    if (options.showMean) {
      layout.shapes = [];
      pageData.forEach((pd, i) => {
        const values = BasePlot.filterNumeric(pd.values);
        if (values.length === 0) return;
        const meanVal = mean(values);
        const color = BasePlot.getPageColor(layoutEngine, pd.pageId, i);
        layout.shapes.push({
          type: 'line',
          x0: meanVal, x1: meanVal, y0: 0, y1: 1,
          yref: 'paper',
          line: { color, width: 2, dash: 'dash' }
        });
      });
    }

    return layout;
  },

  async render(pageData, options, container, layoutEngine) {
    return PlotFactory.render({ definition: this, pageData, options, container, layoutEngine });
  },

  async update(figure, pageData, options, layoutEngine) {
    return PlotFactory.update({ definition: this, figure, pageData, options, layoutEngine });
  },

  exportCSV(pageData, options) {
    const bandwidthMult = getBandwidthMultiplier(options.bandwidth);
    const rows = [];

    for (const pd of pageData) {
      const values = BasePlot.filterNumeric(pd.values);
      if (values.length === 0) continue;

      const { x, y } = calculateDensity(values, bandwidthMult);
      for (let i = 0; i < x.length; i++) {
        rows.push({ page: pd.pageName, x: x[i].toFixed(4), density: y[i].toFixed(6) });
      }
    }

    return {
      rows,
      columns: ['page', 'x', 'density'],
      metadata: { plotType: 'densityplot', pageCount: pageData.length, bandwidth: options.bandwidth, exportDate: new Date().toISOString() }
    };
  }
};

PlotRegistry.register(densityplotDefinition);
export default densityplotDefinition;
