/**
 * Per-type proportions of every sample, as points over a box per
 * condition: what a composition test compares, one point per replicate.
 * Drawn by the composition plot (`composition-bars.js`) when its Plot
 * option is Per sample.
 *
 * Data (built by `ui/analysis-types/composition-ui.js`):
 *   types            cell-type names, in plot order
 *   conditions       condition names
 *   conditionColors  each condition's colour
 *   points           {type: Int32Array, condition: Int32Array, value: Float64Array, label: string[]}
 *   significance     per type, '' or a mark (*, **, ***) from its adjusted p
 *
 * @module plots/types/composition-strips
 */

import { BasePlot, COMMON_HOVER_STYLE } from '../plot-factory.js';
import { getPlotTheme } from '../../shared/plot-theme.js';
import { escapeHtml } from '../../../utils/dom-utils.js';

const compositionStrips = {
  buildTraces(data) {
    const { points } = data;
    if (points.value.length === 0) return [];
    const typeLabels = data.types.map(type => escapeHtml(type));
    return data.conditions.map((condition, conditionIndex) => {
      const x = [];
      const y = [];
      const text = [];
      for (let i = 0; i < points.value.length; i++) {
        if (points.condition[i] !== conditionIndex) continue;
        x.push(typeLabels[points.type[i]]);
        y.push(points.value[i]);
        text.push(escapeHtml(points.label[i]));
      }
      return {
        type: 'box',
        name: escapeHtml(condition),
        x,
        y,
        text,
        boxpoints: 'all',
        jitter: 0.35,
        pointpos: 0,
        fillcolor: 'rgba(0,0,0,0)',
        line: { color: data.conditionColors[conditionIndex], width: 1 },
        marker: { color: data.conditionColors[conditionIndex], size: 5, opacity: 0.85 },
        hovertemplate: `${escapeHtml(condition)} · %{text}<br>%{x}: %{y:.1%}<extra></extra>`,
        hoverlabel: COMMON_HOVER_STYLE
      };
    });
  },

  buildLayout(data) {
    const theme = getPlotTheme();
    const layout = BasePlot.createLayout({ showLegend: true });
    layout.boxmode = 'group';
    layout.xaxis = {
      automargin: true,
      tickangle: data.types.length > 6 ? -60 : 0,
      tickfont: { family: theme.fontFamily, size: 10, color: theme.text }
    };
    layout.yaxis = {
      title: { text: 'Proportion of cells per sample', font: { size: 11, color: theme.text } },
      tickformat: '.0%',
      rangemode: 'tozero',
      automargin: true,
      gridcolor: theme.grid,
      tickfont: { family: theme.fontFamily, size: 10, color: theme.text }
    };
    // Significance marks above each type.
    layout.annotations = data.types.flatMap((type, index) => (data.significance[index]
      ? [{
        x: escapeHtml(type), xref: 'x', y: 1, yref: 'paper', yanchor: 'bottom', showarrow: false,
        text: data.significance[index],
        font: { family: theme.fontFamily, size: 11, color: theme.textStrong }
      }]
      : []));
    layout.legend = {
      orientation: 'h', x: 0, xanchor: 'left', y: 1.08, yanchor: 'bottom',
      font: { family: theme.fontFamily, size: 10, color: theme.legend.text }, bgcolor: theme.legend.bg
    };
    layout.margin = { l: 10, r: 10, t: 20, b: 10 };
    return layout;
  },

  exportCSV(data) {
    const columns = ['cell_type', 'condition', 'sample', 'proportion'];
    const rows = [];
    for (let i = 0; i < data.points.value.length; i++) {
      rows.push({
        cell_type: data.types[data.points.type[i]],
        condition: data.conditions[data.points.condition[i]],
        sample: data.points.label[i],
        proportion: data.points.value[i]
      });
    }
    return { rows, columns, metadata: { plotType: 'composition-strips', exportDate: new Date().toISOString() } };
  }
};

export default compositionStrips;
