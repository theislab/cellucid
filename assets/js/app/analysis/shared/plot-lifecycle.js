/**
 * Plot Lifecycle Utilities
 *
 * Centralizes Plotly lifecycle management to prevent WebGL/DOM leaks:
 * - Prefer `Plotly.react` updates when available (less churn than full re-render)
 * - Select update or render before execution and execute that path exactly once
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
    return plotDef.update(container, data, options, layoutEngine);
  }

  purgePlot(container);
  return plotDef.render(data, options, container, layoutEngine);
}
