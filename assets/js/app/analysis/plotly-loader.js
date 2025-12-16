/**
 * Plotly Lazy Loader
 *
 * Implements lazy loading for Plotly.js to improve initial page load performance.
 * The library is only loaded when the Page Analysis module is first used.
 */

let plotlyLoadPromise = null;
let plotlyLoaded = false;

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
 * @returns {Promise<Object>}
 */
export async function newPlot(container, traces, layout, config) {
  const Plotly = await loadPlotly();
  return Plotly.newPlot(container, traces, layout, config);
}

/**
 * Safe wrapper for Plotly.purge that handles missing Plotly
 * @param {HTMLElement} container
 */
export function purgePlot(container) {
  if (isPlotlyLoaded() && window.Plotly && container) {
    try {
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
  return {
    displayModeBar: true, // CSS handles hover visibility
    displaylogo: false,
    responsive: true,
    modeBarBackgroundColor: 'transparent',
    modeBarColor: '#9ca3af',
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
  return {
    autosize: true,
    margin: { l: 50, r: 20, t: 30, b: 50 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: '#ffffff',
    font: {
      family: 'Inter, system-ui, -apple-system, sans-serif',
      size: 11,
      color: '#374151'
    },
    showlegend: true,
    legend: {
      orientation: 'h',
      yanchor: 'bottom',
      y: 1.02,
      xanchor: 'center',
      x: 0.5,
      font: { size: 10, color: '#374151' },
      bgcolor: 'transparent',
      borderwidth: 0
    },
    xaxis: {
      gridcolor: 'rgba(0,0,0,0.06)',
      gridwidth: 1,
      linecolor: '#e5e7eb',
      linewidth: 1,
      tickfont: { size: 10, color: '#6b7280' },
      title: { font: { size: 11, color: '#374151' } },
      zeroline: false
    },
    yaxis: {
      gridcolor: 'rgba(0,0,0,0.06)',
      gridwidth: 1,
      linecolor: '#e5e7eb',
      linewidth: 1,
      tickfont: { size: 10, color: '#6b7280' },
      title: { font: { size: 11, color: '#374151' } },
      zeroline: false
    },
    hoverlabel: {
      bgcolor: '#111827',
      bordercolor: '#111827',
      font: { family: 'Inter, system-ui, sans-serif', size: 11, color: '#ffffff' }
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

export default {
  loadPlotly,
  isPlotlyLoaded,
  withPlotly,
  newPlot,
  purgePlot,
  downloadImage,
  getPlotlyConfig,
  getPlotlyLayout,
  createMinimalPlotly
};
