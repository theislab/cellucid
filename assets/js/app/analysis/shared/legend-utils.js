/**
 * Legend Utilities
 *
 * Centralized helpers for controlling Plotly legend visibility and position
 * from the shared plot options UI.
 */

import { getPlotTheme } from './plot-theme.js';

/**
 * @typedef {'auto'|'none'|'upper_left'|'center_left'|'lower_left'|'upper_right'|'center_right'|'lower_right'|'outside_right'|'outside_bottom'} LegendPosition
 */

export const LEGEND_DEFAULT_OPTIONS = Object.freeze({
  /** @type {LegendPosition} */
  legendPosition: 'auto'
});

export const LEGEND_POSITION_OPTIONS = Object.freeze([
  { value: 'auto', label: 'Auto' },
  { value: 'none', label: 'None' },
  { value: 'upper_left', label: 'Upper left' },
  { value: 'center_left', label: 'Center left' },
  { value: 'lower_left', label: 'Lower left' },
  { value: 'upper_right', label: 'Upper right' },
  { value: 'center_right', label: 'Center right' },
  { value: 'lower_right', label: 'Lower right' },
  { value: 'outside_right', label: 'Outside right' },
  { value: 'outside_bottom', label: 'Outside bottom' }
]);

export const LEGEND_POSITION_SCHEMA = Object.freeze({
  type: 'select',
  label: 'Show legend',
  options: LEGEND_POSITION_OPTIONS
});

/**
 * Whether a layout already reserved a place for its legend below the plot area.
 *
 * @param {Object} legend - The layout's existing `legend` object.
 * @returns {boolean}
 */
function placesLegendBelowPlot(legend) {
  return (
    legend !== null &&
    typeof legend === 'object' &&
    legend.orientation === 'h' &&
    typeof legend.y === 'number' &&
    legend.y < 0
  );
}

/**
 * Apply legend position option to a Plotly layout.
 * Mutates the input layout (which is typically freshly created per render).
 *
 * @param {Object} layout - Plotly layout object
 * @param {LegendPosition|string|undefined|null} legendPosition
 * @returns {Object} The same layout reference
 */
export function applyLegendPosition(layout, legendPosition) {
  if (!layout || typeof layout !== 'object') return layout;

  const theme = getPlotTheme();

  /** @type {LegendPosition} */
  const pos = typeof legendPosition === 'string' ? legendPosition : 'auto';

  if (pos === 'auto') return layout;

  if (pos === 'none') {
    layout.showlegend = false;
    return layout;
  }

  layout.showlegend = true;

  const baseLegend = layout.legend && typeof layout.legend === 'object' ? layout.legend : {};
  const legend = { ...baseLegend };

  if (legend.bgcolor === undefined) legend.bgcolor = theme.legend.bg;
  if (legend.bordercolor === undefined) legend.bordercolor = theme.legend.border;
  if (legend.borderwidth === undefined) legend.borderwidth = 1;
  if (!legend.font) legend.font = { family: theme.fontFamily, size: theme.legendFontSize, color: theme.legend.text };

  switch (pos) {
    case 'upper_left':
      legend.x = 0;
      legend.y = 1;
      legend.xanchor = 'left';
      legend.yanchor = 'top';
      legend.orientation = 'v';
      break;
    case 'center_left':
      legend.x = 0;
      legend.y = 0.5;
      legend.xanchor = 'left';
      legend.yanchor = 'middle';
      legend.orientation = 'v';
      break;
    case 'lower_left':
      legend.x = 0;
      legend.y = 0;
      legend.xanchor = 'left';
      legend.yanchor = 'bottom';
      legend.orientation = 'v';
      break;
    case 'upper_right':
      legend.x = 1;
      legend.y = 1;
      legend.xanchor = 'right';
      legend.yanchor = 'top';
      legend.orientation = 'v';
      break;
    case 'center_right':
      legend.x = 1;
      legend.y = 0.5;
      legend.xanchor = 'right';
      legend.yanchor = 'middle';
      legend.orientation = 'v';
      break;
    case 'lower_right':
      legend.x = 1;
      legend.y = 0;
      legend.xanchor = 'right';
      legend.yanchor = 'bottom';
      legend.orientation = 'v';
      break;
    case 'outside_right':
      legend.x = 1.02;
      legend.y = 1;
      legend.xanchor = 'left';
      legend.yanchor = 'top';
      legend.orientation = 'v';
      break;
    case 'outside_bottom':
      legend.x = 0.5;
      legend.xanchor = 'center';
      legend.yanchor = 'top';
      legend.orientation = 'h';
      // A plot that already places its legend below the plot area has measured
      // the band it needs — tick labels, then the axis title, then the legend —
      // and expressed the offset in paper units derived from its own pixel
      // geometry. Replacing that with a constant is how the volcano's axis
      // title came to be drawn across its `Down (n)` entry. `-0.05` places the
      // legend for a plot that reserved nothing; it never overrides one that did.
      if (!placesLegendBelowPlot(baseLegend)) legend.y = -0.05;
      break;
    default:
      return layout;
  }

  layout.legend = legend;

  if (pos === 'outside_right') {
    const margin = layout.margin && typeof layout.margin === 'object' ? layout.margin : {};
    const right = typeof margin.r === 'number' ? margin.r : 0;
    layout.margin = { ...margin, r: Math.max(right, 160) };
  }

  if (pos === 'outside_bottom' && !placesLegendBelowPlot(baseLegend)) {
    const margin = layout.margin && typeof layout.margin === 'object' ? layout.margin : {};
    const bottom = typeof margin.b === 'number' ? margin.b : 0;
    layout.margin = { ...margin, b: Math.max(bottom, 90) };
  }

  return layout;
}
