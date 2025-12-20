/**
 * Plot Lifecycle Utilities
 *
 * Centralizes Plotly lifecycle management to prevent WebGL/DOM leaks:
 * - Prefer `Plotly.react` updates when available (less churn than full re-render)
 * - Fall back to `purge + render` on errors or when no update path exists
 *
 * @module shared/plot-lifecycle
 */

import { loadPlotly, purgePlot } from '../plots/plotly-loader.js';

/**
 * Render or update a Plotly plot using a plot definition from PlotRegistry.
 *
 * The plot definition is expected to implement:
 * - `render(data, options, container, layoutEngine)`
 * - optionally `update(figure, data, options, layoutEngine)`
 *
 * @param {Object} params
 * @param {{ render: Function, update?: Function, id?: string }} params.plotDef
 * @param {*} params.data
 * @param {Object} params.options
 * @param {HTMLElement} params.container
 * @param {Object|null} [params.layoutEngine=null]
 * @param {boolean} [params.preferUpdate=true]
 * @returns {Promise<any>}
 */
export async function renderOrUpdatePlot({
  plotDef,
  data,
  options,
  container,
  layoutEngine = null,
  preferUpdate = true
}) {
  if (!plotDef || !container) {
    throw new Error('renderOrUpdatePlot requires plotDef and container');
  }

  await loadPlotly();

  if (preferUpdate && typeof plotDef.update === 'function') {
    try {
      return await plotDef.update(container, data, options, layoutEngine);
    } catch (_err) {
      // Fall back to full re-render below.
    }
  }

  purgePlot(container);
  return plotDef.render(data, options, container, layoutEngine);
}

/**
 * Purge a Plotly plot if present.
 * @param {HTMLElement|null} container
 */
export function safePurgePlot(container) {
  if (!container) return;
  purgePlot(container);
}

export default {
  renderOrUpdatePlot,
  safePurgePlot
};

