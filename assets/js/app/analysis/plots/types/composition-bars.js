/**
 * Stacked bars of cell-type composition: one bar per sample (or per
 * condition), one segment per cell type, as proportions or cell counts.
 *
 * With samples, the **Plot** option switches to the per-sample points
 * (`composition-strips.js`): `data.bars` and `data.strips` hold both.
 *
 * Data (built by `ui/analysis-types/composition-ui.js`), `data.bars`:
 *   types        cell-type names, bottom segment first
 *   typeColors   each type's colour (the field's palette)
 *   bars         [{label, group}] one per bar; `group` is the condition the
 *                bar belongs to ('' without one) and labels the axis below
 *   values       Float64Array `values[type * bars + bar]`
 *   proportions  whether `values` are proportions (else cell counts)
 *
 * @module plots/types/composition-bars
 */

import { PlotFactory, PlotRegistry, BasePlot, COMMON_HOVER_STYLE } from '../plot-factory.js';
import { getPlotTheme } from '../../shared/plot-theme.js';
import { escapeHtml } from '../../../utils/dom-utils.js';
import compositionStrips from './composition-strips.js';

const showsStrips = (data, options) => options.view === 'strips' && data.strips !== null;

const compositionBarsDefinition = {
  id: 'composition-bars',
  name: 'Composition bars',
  description: 'Cell-type proportions per sample or condition, as stacked bars',
  supportedTypes: ['composition'],
  supportedLayouts: ['single'],
  supportsLegend: true,

  // The legend's place (or none) is the shared Legend option every plot
  // with a legend has.
  defaultOptions: { view: 'bars' },

  optionSchema: {
    view: {
      type: 'select',
      label: 'Plot',
      options: [
        { value: 'bars', label: 'Stacked bars' },
        { value: 'strips', label: 'Per sample' }
      ]
    }
  },

  buildTraces(composition, options) {
    if (showsStrips(composition, options)) return compositionStrips.buildTraces(composition.strips, options);
    const data = composition.bars;
    const barCount = data.bars.length;
    if (barCount === 0 || data.types.length === 0) return [];
    // A bar's axis position: its condition and its own label, so bars of one
    // condition sit together under it.
    const grouped = data.bars.some(bar => bar.group !== '');
    const x = grouped
      ? [data.bars.map(bar => escapeHtml(bar.group)), data.bars.map(bar => escapeHtml(bar.label))]
      : data.bars.map(bar => escapeHtml(bar.label));
    return data.types.map((type, typeIndex) => {
      const y = Array.from({ length: barCount }, (_, bar) => data.values[typeIndex * barCount + bar]);
      return {
        type: 'bar',
        name: escapeHtml(type),
        x,
        y,
        marker: { color: data.typeColors[typeIndex], line: { width: 0 } },
        hovertemplate: data.proportions
          ? `${escapeHtml(type)}<br>%{x}: %{y:.1%}<extra></extra>`
          : `${escapeHtml(type)}<br>%{x}: %{y:,} cells<extra></extra>`,
        hoverlabel: COMMON_HOVER_STYLE
      };
    });
  },

  buildLayout(composition, options) {
    if (showsStrips(composition, options)) return compositionStrips.buildLayout(composition.strips, options);
    const data = composition.bars;
    const theme = getPlotTheme();
    const layout = BasePlot.createLayout({ showLegend: true });
    layout.barmode = 'stack';
    layout.bargap = 0.15;
    const many = data.bars.length > 12;
    layout.xaxis = {
      automargin: true,
      tickangle: data.bars.length > 8 ? -90 : 0,
      tickfont: { family: theme.fontFamily, size: many ? 8 : 10, color: theme.text }
    };
    layout.yaxis = {
      title: { text: data.proportions ? 'Proportion of cells' : 'Cells', font: { size: 11, color: theme.text } },
      tickformat: data.proportions ? '.0%' : ',d',
      range: data.proportions ? [0, 1] : undefined,
      automargin: true,
      gridcolor: theme.grid,
      tickfont: { family: theme.fontFamily, size: 10, color: theme.text }
    };
    // Above the bars, in rows: beside them it would take the sidebar's
    // whole width.
    layout.legend = {
      orientation: 'h',
      x: 0,
      xanchor: 'left',
      y: 1.02,
      yanchor: 'bottom',
      traceorder: 'normal',
      font: { family: theme.fontFamily, size: 10, color: theme.legend.text },
      bgcolor: theme.legend.bg
    };
    layout.margin = { l: 10, r: 10, t: 10, b: 10 };
    return layout;
  },

  async render(data, options, container, layoutEngine) {
    return PlotFactory.render({ definition: this, pageData: data, options, container, layoutEngine });
  },

  async update(figure, data, options, layoutEngine) {
    return PlotFactory.update({ definition: this, figure, pageData: data, options, layoutEngine });
  },

  exportCSV(composition, options) {
    if (showsStrips(composition, options)) return compositionStrips.exportCSV(composition.strips);
    const data = composition.bars;
    const columns = ['bar', 'condition', 'cell_type', data.proportions ? 'proportion' : 'cells'];
    const rows = [];
    data.bars.forEach((bar, barIndex) => {
      data.types.forEach((type, typeIndex) => {
        rows.push({
          bar: bar.label,
          condition: bar.group,
          cell_type: type,
          [columns[3]]: data.values[typeIndex * data.bars.length + barIndex]
        });
      });
    });
    return { rows, columns, metadata: { plotType: 'composition-bars', exportDate: new Date().toISOString() } };
  }
};

PlotRegistry.register(compositionBarsDefinition);
export default compositionBarsDefinition;
