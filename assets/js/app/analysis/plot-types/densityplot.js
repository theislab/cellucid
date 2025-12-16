/**
 * Density Plot Type
 *
 * Kernel density estimation for continuous variables.
 * Supports overlay mode for comparing multiple pages on the same axes.
 */

import { PlotRegistry, PlotHelpers, getPageColor } from '../plot-registry.js';
import { getPlotlyConfig, createMinimalPlotly } from '../plotly-loader.js';

/**
 * Simple kernel density estimation using Gaussian kernel
 * @param {number[]} data - Data points
 * @param {number} bandwidth - Kernel bandwidth (or 'auto')
 * @param {number} nPoints - Number of points for the output curve
 * @returns {Object} { x: number[], y: number[] }
 */
function kernelDensity(data, bandwidth = 'auto', nPoints = 100) {
  if (!data || data.length === 0) {
    return { x: [], y: [] };
  }

  // Filter valid numbers
  const validData = data.filter(v => typeof v === 'number' && !Number.isNaN(v));
  if (validData.length === 0) {
    return { x: [], y: [] };
  }

  const n = validData.length;
  const min = Math.min(...validData);
  const max = Math.max(...validData);
  const range = max - min;

  if (range === 0) {
    // All values are the same
    return { x: [min], y: [1] };
  }

  // Calculate bandwidth using Silverman's rule of thumb if auto
  let h = bandwidth;
  if (bandwidth === 'auto') {
    const mean = validData.reduce((a, b) => a + b, 0) / n;
    const variance = validData.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    const std = Math.sqrt(variance);
    h = 1.06 * std * Math.pow(n, -0.2);
    if (h <= 0 || !Number.isFinite(h)) {
      h = range / 10;
    }
  }

  // Generate evaluation points
  const padding = h * 3;
  const x = [];
  const step = (range + 2 * padding) / (nPoints - 1);
  for (let i = 0; i < nPoints; i++) {
    x.push(min - padding + i * step);
  }

  // Evaluate density at each point
  const y = x.map(xi => {
    let sum = 0;
    for (const d of validData) {
      const u = (xi - d) / h;
      // Gaussian kernel
      sum += Math.exp(-0.5 * u * u) / Math.sqrt(2 * Math.PI);
    }
    return sum / (n * h);
  });

  return { x, y };
}

const densityplot = {
  id: 'densityplot',
  name: 'Density Plot',
  description: 'Smoothed distribution curve',
  supportedDataTypes: ['continuous'],
  supportedLayouts: ['overlay', 'side-by-side'],

  optionSchema: {
    fillOpacity: {
      type: 'range',
      label: 'Fill',
      min: 0,
      max: 100,
      step: 10,
      default: 30
    },
    bandwidth: {
      type: 'select',
      label: 'Bandwidth',
      options: [
        { value: 'auto', label: 'Auto' },
        { value: 'narrow', label: 'Narrow' },
        { value: 'wide', label: 'Wide' }
      ],
      default: 'auto'
    },
    logX: {
      type: 'checkbox',
      label: 'Log X'
    },
    logY: {
      type: 'checkbox',
      label: 'Log Y'
    },
    showMean: {
      type: 'checkbox',
      label: 'Mean line',
      default: true
    }
  },

  defaultOptions: {
    fillOpacity: 30,
    bandwidth: 'auto',
    showMean: true,
    logX: false,
    logY: false
  },

  /**
   * Render density plot
   * @param {Object[]} pageData - Data for each page
   * @param {Object} options - Plot options
   * @param {HTMLElement} container - Container element
   * @param {Object} layoutEngine - Layout engine instance
   */
  async render(pageData, options, container, layoutEngine) {
    const Plotly = await createMinimalPlotly();

    const traces = [];
    const shapes = [];
    let maxDensity = 0;
    let minX = Infinity;
    let maxX = -Infinity;

    // Calculate bandwidth multiplier
    let bandwidthMult = 1;
    if (options.bandwidth === 'narrow') bandwidthMult = 0.5;
    if (options.bandwidth === 'wide') bandwidthMult = 2;

    // Process each page
    pageData.forEach((pd, index) => {
      const color = getPageColor(index);
      const validValues = pd.values.filter(v => typeof v === 'number' && !Number.isNaN(v));

      if (validValues.length === 0) return;

      // Calculate density
      const kdeResult = kernelDensity(validValues, 'auto');
      if (kdeResult.x.length === 0) return;

      // Apply bandwidth multiplier by recalculating if needed
      let { x, y } = kdeResult;

      if (bandwidthMult !== 1) {
        const mean = validValues.reduce((a, b) => a + b, 0) / validValues.length;
        const variance = validValues.reduce((a, b) => a + (b - mean) ** 2, 0) / validValues.length;
        const std = Math.sqrt(variance);
        const h = 1.06 * std * Math.pow(validValues.length, -0.2) * bandwidthMult;
        const recalc = kernelDensity(validValues, h);
        x = recalc.x;
        y = recalc.y;
      }

      const densityMax = Math.max(...y);
      if (densityMax > maxDensity) maxDensity = densityMax;
      if (x.length > 0) {
        minX = Math.min(minX, x[0]);
        maxX = Math.max(maxX, x[x.length - 1]);
      }

      // Main density trace
      const fillOpacity = options.fillOpacity / 100;
      const rgbaColor = hexToRgba(color, fillOpacity);

      traces.push({
        type: 'scatter',
        mode: 'lines',
        x: x,
        y: y,
        name: pd.pageName,
        line: {
          color: color,
          width: 2,
          shape: 'spline'
        },
        fill: 'tozeroy',
        fillcolor: rgbaColor,
        hovertemplate: `${pd.pageName}<br>Value: %{x:.2f}<br>Density: %{y:.4f}<extra></extra>`
      });

      // Mean line
      if (options.showMean && validValues.length > 0) {
        const mean = validValues.reduce((a, b) => a + b, 0) / validValues.length;
        shapes.push({
          type: 'line',
          x0: mean,
          x1: mean,
          y0: 0,
          y1: 1,
          yref: 'paper',
          line: {
            color: color,
            width: 2,
            dash: 'dash'
          }
        });
      }
    });

    // Layout - use PlotHelpers for consistency with other plot types
    const variableName = pageData[0]?.variableInfo?.name || pageData[0]?.variableInfo?.key || 'Value';
    const layout = PlotHelpers.createBaseLayout({
      showLegend: pageData.length > 1
    });

    layout.xaxis = {
      title: variableName,
      automargin: true,
      type: options.logX ? 'log' : 'linear'
    };

    layout.yaxis = {
      title: 'Density',
      zeroline: true,
      rangemode: 'tozero',
      type: options.logY ? 'log' : 'linear'
    };

    layout.shapes = shapes;

    // Render
    await Plotly.newPlot(container, traces, layout, getPlotlyConfig());

    return { traces, layout };
  }
};

/**
 * Convert hex color to rgba
 */
function hexToRgba(hex, alpha) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return `rgba(100,100,100,${alpha})`;
  const r = parseInt(result[1], 16);
  const g = parseInt(result[2], 16);
  const b = parseInt(result[3], 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

PlotRegistry.register(densityplot);
export default densityplot;
