/**
 * Plotly Lazy Loader
 *
 * Implements lazy loading for Plotly.js to improve initial page load performance.
 * The library is only loaded when the Page Analysis module is first used.
 *
 * RENDERING POLICY:
 * - Every 2D Cartesian scatter trace uses Plotly's SVG `scatter` renderer.
 * - Plotly heatmaps that explicitly select `heatmapgl` require WebGL2.
 * - A trace renderer is selected once before execution and is never changed to a
 *   different renderer after failure.
 *
 * Also provides hint management integration - see plotly-hints.js
 */

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * @typedef {'scatter'|'scatter3d'|'heatmapgl'|'heatmap'|'histogram'|'box'|'violin'|'bar'|'pie'} TraceType
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

import { attachPlotlyHints, hidePlotlyNativeHints } from './plotly-hints.js';
import { announceIfUpdated } from '../../app-code.js';
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

/** The sole current Plotly renderer for every 2D Cartesian scatter trace. */
export const PLOTLY_2D_SCATTER_TRACE_TYPE = 'scatter';

/**
 * Verify WebGL2 support.
 *
 * Two-dimensional scatter plots do not use WebGL. Explicit WebGL plot types
 * and compute backends still use this capability guard.
 *
 * @throws {Error} If WebGL2 is not supported
 */
function requireWebGL2() {
  if (!isWebGL2Available()) {
    throw new Error('WebGL2 is required for GPU acceleration.');
  }
}

/**
 * Check if WebGL2 is available (does not throw)
 * @returns {boolean}
 */
function isWebGL2Available() {
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
 * Get the preferred heatmap trace type.
 * @returns {'heatmapgl'|'heatmap'}
 */
export function getHeatmapTraceType() {
  requireWebGL2();
  return 'heatmapgl';
}

/**
 * Check if Plotly is already loaded
 * @returns {boolean}
 */
function isPlotlyLoaded() {
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
    hidePlotlyNativeHints();
    attachPlotlyHints();
    nativeHintsHidden = true;
    return Promise.resolve(window.Plotly);
  }

  // Loading in progress
  if (plotlyLoadPromise) {
    return plotlyLoadPromise;
  }

  // Start loading
  plotlyLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    // Resolved through the page's import map, so the URL names the bytes
    // (index.html, CELLUCID_MODULE_VERSIONS).
    script.src = import.meta.resolve('../../../../external/plotly.min.js');
    script.async = true;

    script.onload = () => {
      plotlyLoaded = true;
      // Initialize Plotly hint/notification interception once Plotly is available.
      // This ensures plots created via Plotly.newPlot directly (e.g. PlotFactory)
      // still get the same notification UX as plots created through our wrappers.
      hidePlotlyNativeHints();
      attachPlotlyHints();
      nativeHintsHidden = true;
      resolve(window.Plotly);
    };

    script.onerror = (err) => {
      plotlyLoadPromise = null;
      void announceIfUpdated();
      console.error('[PlotlyLoader] Failed to load Plotly.js:', err);
      reject(new Error('Failed to load Plotly.js library'));
    };

    document.head.appendChild(script);
  });

  return plotlyLoadPromise;
}

/** Longest wait for an idle moment before a prefetch loads anyway (a scheduling choice). */
const PREFETCH_IDLE_TIMEOUT_MS = 2000;

let prefetchScheduled = false;

/**
 * Load Plotly ahead of the first plot, at the page's next idle moment.
 *
 * Evaluating the library is one long main-thread task (its bundle runs as
 * one script). An analysis opening is the sign a plot is coming: loading it
 * then, while the person sets the analysis up, keeps that task out of the
 * run that draws the first plot, which finds the library loaded (or the same
 * load under way, `loadPlotly`). A failed prefetch leaves nothing behind:
 * the plot's own load tries again and reports.
 */
export function prefetchPlotly() {
  if (isPlotlyLoaded() || plotlyLoadPromise !== null || prefetchScheduled) return;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  prefetchScheduled = true;
  const start = () => {
    prefetchScheduled = false;
    loadPlotly().catch(() => {});
  };
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(start, { timeout: PREFETCH_IDLE_TIMEOUT_MS });
  } else {
    // No idle callback (WebKit): after the frame that shows the opened
    // analysis has been drawn.
    window.requestAnimationFrame(() => setTimeout(start, 0));
  }
}

/**
 * Safe wrapper for Plotly.purge that handles missing Plotly
 * @param {HTMLElement} container
 */
export function purgePlot(container) {
  if (container === null || container === undefined) return;
  if (!isPlotlyLoaded()) return;
  if (typeof window.Plotly?.purge !== 'function') {
    throw new TypeError('Plotly.purge is required for plot cleanup');
  }
  window.Plotly.purge(container);
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
 * Create minimal Plotly instance (lazy loads Plotly first)
 * Returns the Plotly object for direct use
 * @returns {Promise<typeof Plotly>}
 */
export async function createMinimalPlotly() {
  return await loadPlotly();
}
