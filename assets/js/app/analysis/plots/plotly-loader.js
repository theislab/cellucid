/**
 * Plotly Lazy Loader
 *
 * Implements lazy loading for Plotly.js to improve initial page load performance.
 * The library is only loaded when the Page Analysis module is first used.
 *
 * GPU RENDERING POLICY:
 * - Prefer WebGL2 when available (scattergl/heatmapgl) for performance
 * - Fall back to non-WebGL traces (scatter/heatmap) when WebGL2 is unavailable
 * - Rendering must remain functional across browsers/devices
 *
 * Also provides hint management integration - see plotly-hints.js
 */

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * @typedef {'scattergl'|'scatter'|'scatter3d'|'heatmapgl'|'heatmap'|'histogram'|'box'|'violin'|'bar'|'pie'} TraceType
 * Plotly trace types used by the analysis module.
 */

/**
 * @typedef {Object} PlotlyTrace
 * @property {TraceType} type - Trace type
 * @property {string} [name] - Trace name for legend
 * @property {number[]} [x] - X values
 * @property {number[]} [y] - Y values
 * @property {number[][]} [z] - Z matrix (for heatmaps)
 * @property {Object} [marker] - Marker configuration
 * @property {string} [marker.color] - Marker color
 * @property {number} [marker.size] - Marker size
 * @property {number} [marker.opacity] - Marker opacity
 * @property {Object} [line] - Line configuration
 * @property {string} [mode] - Trace mode ('markers', 'lines', 'markers+lines')
 * @property {string} [hovertemplate] - Hover text template
 * @property {Object} [hoverlabel] - Hover label styling
 * @property {boolean} [showlegend] - Whether to show in legend
 * @property {any[]} [customdata] - Custom data for hover callbacks
 * @property {string[]} [text] - Text labels
 */

/**
 * @typedef {Object} PlotlyLayout
 * @property {Object} [xaxis] - X axis configuration
 * @property {Object} [yaxis] - Y axis configuration
 * @property {Object} [margin] - Plot margins
 * @property {boolean} [showlegend] - Show legend
 * @property {Object} [legend] - Legend configuration
 * @property {Object[]} [annotations] - Annotations array
 * @property {Object[]} [shapes] - Shapes array
 * @property {string} [paper_bgcolor] - Paper background color
 * @property {string} [plot_bgcolor] - Plot background color
 * @property {Object} [font] - Font configuration
 */

/**
 * @typedef {Object} PlotlyConfig
 * @property {boolean} [displayModeBar] - Show mode bar
 * @property {boolean} [displaylogo] - Show Plotly logo
 * @property {boolean} [responsive] - Responsive sizing
 * @property {string[]} [modeBarButtonsToRemove] - Buttons to remove
 * @property {Object} [toImageButtonOptions] - Image export options
 */

/**
 * @typedef {Object} PlotPerformanceOptions
 * @property {number} densityPointThreshold - Points threshold for density mode
 * @property {number} maxRenderPoints - Maximum points to render
 * @property {number} sampleSize - Sample size when exceeding max
 */

import { attachPlotlyHints, detachPlotlyHints, hidePlotlyNativeHints } from './plotly-hints.js';
import { applyThemeToAllPlots, getPlotTheme, invalidatePlotThemeCache } from '../shared/plot-theme.js';

// Keep Plotly charts in sync with the active CSS theme.
if (typeof window !== 'undefined') {
  window.addEventListener('cellucid:theme-change', () => {
    invalidatePlotThemeCache();
    void applyThemeToAllPlots();
  });
}

let plotlyLoadPromise = null;
let plotlyLoaded = false;
let nativeHintsHidden = false;

// WebGL2 verification state
let _webgl2Verified = false;
let _webgl2Available = false;

/**
 * Performance configuration for plot rendering
 * @type {Object}
 */
export const PlotPerformanceConfig = {
  // Point count threshold to enable density mode
  densityPointThreshold: 5000,
  // Maximum points to render (beyond this, sample)
  maxRenderPoints: 100000,
  // Sample size when exceeding maxRenderPoints
  sampleSize: 50000
};

/**
 * GPU-accelerated trace types mapping
 * All rendering uses WebGL - no SVG fallbacks
 * @type {Object}
 */
export const GPU_TRACE_TYPES = {
  scatter: 'scattergl',
  scatter3d: 'scatter3d',
  heatmap: 'heatmapgl',
  histogram: 'histogram',
  box: 'box',
  violin: 'violin',
  bar: 'bar',
  pie: 'pie'
};

/**
 * Verify WebGL2 support.
 *
 * Note: Plot rendering has non-WebGL fallbacks, but some compute backends
 * (GPUCompute) may still require WebGL2. This helper is kept for those cases.
 *
 * @throws {Error} If WebGL2 is not supported
 */
export function requireWebGL2() {
  if (!isWebGL2Available()) {
    throw new Error('WebGL2 is required for GPU acceleration.');
  }
}

/**
 * Check if WebGL2 is available (does not throw)
 * @returns {boolean}
 */
export function isWebGL2Available() {
  if (_webgl2Verified) return _webgl2Available;

  _webgl2Verified = true;

  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');

    if (!gl) {
      _webgl2Available = false;
      return false;
    }

    _webgl2Available = true;

    // Clean up context
    const ext = gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  } catch (_err) {
    _webgl2Available = false;
  }

  return _webgl2Available;
}

/**
 * Get the preferred scatter trace type.
 * @returns {'scattergl'|'scatter'}
 */
export function getScatterTraceType() {
  return isWebGL2Available() ? 'scattergl' : 'scatter';
}

/**
 * Get the preferred heatmap trace type.
 * @returns {'heatmapgl'|'heatmap'}
 */
export function getHeatmapTraceType() {
  return isWebGL2Available() ? 'heatmapgl' : 'heatmap';
}

/**
 * Get the preferred trace type for any base type.
 * @param {string} baseType - Base trace type (scatter, heatmap, etc.)
 * @returns {string} GPU-accelerated trace type
 */
export function getGPUTraceType(baseType) {
  if (baseType === 'scatter') return getScatterTraceType();
  if (baseType === 'heatmap') return getHeatmapTraceType();

  if ((baseType === 'scattergl' || baseType === 'heatmapgl') && !isWebGL2Available()) {
    return baseType === 'scattergl' ? 'scatter' : 'heatmap';
  }

  return GPU_TRACE_TYPES[baseType] || baseType;
}

/**
 * Sample large datasets for rendering performance
 * @param {number[]} xData - X values
 * @param {number[]} yData - Y values
 * @param {Object} [additionalArrays] - Additional arrays to sample in sync
 * @param {number} [maxPoints] - Maximum points to return
 * @returns {Object} Sampled data with same structure
 */
export function sampleLargeDataset(xData, yData, additionalArrays = {}, maxPoints = PlotPerformanceConfig.sampleSize) {
  const n = Math.min(xData.length, yData.length);

  if (n <= maxPoints) {
    return { x: xData, y: yData, ...additionalArrays, sampled: false };
  }

  // Stratified sampling to preserve distribution
  const step = n / maxPoints;
  const sampledX = [];
  const sampledY = [];
  const sampledAdditional = {};

  for (const key of Object.keys(additionalArrays)) {
    sampledAdditional[key] = [];
  }

  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.min(Math.floor(i * step), n - 1);
    sampledX.push(xData[idx]);
    sampledY.push(yData[idx]);

    for (const key of Object.keys(additionalArrays)) {
      if (additionalArrays[key] && additionalArrays[key][idx] !== undefined) {
        sampledAdditional[key].push(additionalArrays[key][idx]);
      }
    }
  }

  return {
    x: sampledX,
    y: sampledY,
    ...sampledAdditional,
    sampled: true,
    originalCount: n,
    sampledCount: maxPoints
  };
}

/**
 * Check if Plotly is already loaded
 * @returns {boolean}
 */
export function isPlotlyLoaded() {
  return plotlyLoaded || (typeof window !== 'undefined' && typeof window.Plotly !== 'undefined');
}

/**
 * Load Plotly.js library lazily
 * @returns {Promise<typeof Plotly>} Resolves with the Plotly object when loaded
 */
export function loadPlotly() {
  // Already loaded
  if (isPlotlyLoaded()) {
    plotlyLoaded = true;
    // Ensure Plotly notifications are routed through NotificationCenter even if
    // Plotly was loaded outside this lazy loader.
    try {
      hidePlotlyNativeHints();
      attachPlotlyHints();
      nativeHintsHidden = true;
    } catch (_err) {
      // Ignore - hint patching is best-effort
    }
    return Promise.resolve(window.Plotly);
  }

  // Loading in progress
  if (plotlyLoadPromise) {
    return plotlyLoadPromise;
  }

  // Start loading
  plotlyLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'assets/external/plotly.min.js';
    script.async = true;

    script.onload = () => {
      plotlyLoaded = true;
      // Initialize Plotly hint/notification interception once Plotly is available.
      // This ensures plots created via Plotly.newPlot directly (e.g. PlotFactory)
      // still get the same notification UX as plots created through our wrappers.
      try {
        hidePlotlyNativeHints();
        attachPlotlyHints();
        nativeHintsHidden = true;
      } catch (_err) {
        // Ignore - hint patching is best-effort
      }
      resolve(window.Plotly);
    };

    script.onerror = (err) => {
      plotlyLoadPromise = null;
      console.error('[PlotlyLoader] Failed to load Plotly.js:', err);
      reject(new Error('Failed to load Plotly.js library'));
    };

    document.head.appendChild(script);
  });

  return plotlyLoadPromise;
}

/**
 * Ensure Plotly is loaded before executing a callback
 * @param {Function} callback - Function to execute after Plotly is loaded
 * @returns {Promise<any>} Result of the callback
 */
export async function withPlotly(callback) {
  await loadPlotly();
  return callback(window.Plotly);
}

/**
 * Safe wrapper for Plotly.newPlot that handles loading
 * @param {HTMLElement} container
 * @param {Object[]} traces
 * @param {Object} layout
 * @param {Object} config
 * @param {Object} [hintOptions] - Options for hint management
 * @param {boolean} [hintOptions.enableHints=true] - Attach custom hints
 * @param {string} [hintOptions.plotName] - Name to include in hints
 * @returns {Promise<Object>}
 */
export async function newPlot(container, traces, layout, config, hintOptions = {}) {
  const Plotly = await loadPlotly();

  // Hide native Plotly hints on first plot creation
  if (!nativeHintsHidden) {
    hidePlotlyNativeHints();
    nativeHintsHidden = true;
  }

  const figure = await Plotly.newPlot(container, traces, layout, config);

  // Attach custom hints unless disabled
  if (hintOptions.enableHints !== false) {
    attachPlotlyHints(container, {
      plotName: hintOptions.plotName,
      showZoomHints: true
    });
  }

  return figure;
}

/**
 * Safe wrapper for Plotly.purge that handles missing Plotly
 * @param {HTMLElement} container
 */
export function purgePlot(container) {
  if (isPlotlyLoaded() && window.Plotly && container) {
    try {
      // Detach hints before purging
      detachPlotlyHints(container);

      window.Plotly.purge(container);
    } catch (e) {
      // Ignore errors during cleanup
    }
  }
}

/**
 * Safe wrapper for Plotly.downloadImage
 * @param {HTMLElement} container
 * @param {Object} options
 * @returns {Promise<void>}
 */
export async function downloadImage(container, options) {
  const Plotly = await loadPlotly();
  return Plotly.downloadImage(container, options);
}

/**
 * Get minimal Plotly config for clean, responsive charts
 * @returns {Object}
 */
export function getPlotlyConfig() {
  const theme = getPlotTheme();
  return {
    displayModeBar: true, // CSS handles hover visibility
    displaylogo: false,
    responsive: true,
    modeBarBackgroundColor: 'transparent',
    modeBarColor: theme.modeBarColor,
    modeBarButtonsToRemove: [
      'sendDataToCloud',
      'lasso2d',
      'select2d',
      'autoScale2d',
      'hoverClosestCartesian',
      'hoverCompareCartesian',
      'toggleSpikelines'
    ],
    modeBarButtonsToAdd: [],
    toImageButtonOptions: {
      format: 'png',
      filename: 'plot',
      height: 800,
      width: 1200,
      scale: 2
    }
  };
}

/**
 * Get base Plotly layout matching the website's minimalist design
 * @param {Object} options - Additional layout options
 * @returns {Object}
 */
export function getPlotlyLayout(options = {}) {
  const theme = getPlotTheme();
  return {
    autosize: true,
    margin: { l: 50, r: 20, t: 30, b: 50 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: theme.plotBg,
    font: {
      family: theme.fontFamily,
      size: theme.fontSize,
      color: theme.text
    },
    showlegend: true,
    legend: {
      orientation: 'h',
      yanchor: 'bottom',
      y: 1.02,
      xanchor: 'center',
      x: 0.5,
      font: { size: theme.legendFontSize, color: theme.text },
      bgcolor: 'transparent',
      borderwidth: 0
    },
    xaxis: {
      gridcolor: theme.grid,
      gridwidth: 1,
      linecolor: theme.axisLine,
      linewidth: 1,
      tickfont: { size: theme.tickFontSize, color: theme.textMuted },
      title: { font: { size: theme.titleFontSize, color: theme.text } },
      zeroline: false
    },
    yaxis: {
      gridcolor: theme.grid,
      gridwidth: 1,
      linecolor: theme.axisLine,
      linewidth: 1,
      tickfont: { size: theme.tickFontSize, color: theme.textMuted },
      title: { font: { size: theme.titleFontSize, color: theme.text } },
      zeroline: false
    },
    hoverlabel: {
      bgcolor: theme.hover.bg,
      bordercolor: theme.hover.border,
      font: { family: theme.fontFamily, size: theme.fontSize, color: theme.hover.text }
    },
    ...options
  };
}

/**
 * Create minimal Plotly instance (lazy loads Plotly first)
 * Returns the Plotly object for direct use
 * @returns {Promise<typeof Plotly>}
 */
export async function createMinimalPlotly() {
  return await loadPlotly();
}

// Re-export hint management functions for convenience
export { attachPlotlyHints, detachPlotlyHints, hidePlotlyNativeHints };

export default {
  loadPlotly,
  isPlotlyLoaded,
  withPlotly,
  newPlot,
  purgePlot,
  downloadImage,
  getPlotlyConfig,
  getPlotlyLayout,
  createMinimalPlotly,
  // Hint management
  attachPlotlyHints,
  detachPlotlyHints,
  hidePlotlyNativeHints,
  // WebGL2 / GPU acceleration helpers
  requireWebGL2,
  isWebGL2Available,
  getScatterTraceType,
  getHeatmapTraceType,
  getGPUTraceType,
  GPU_TRACE_TYPES,
  sampleLargeDataset,
  PlotPerformanceConfig
};
