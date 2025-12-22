/**
 * Heatmap Plot Type
 *
 * Matrix view comparing multiple categorical variables across pages.
 * Shows category counts as a color-coded grid.
 * Refactored to use PlotFactory for reduced code duplication.
 */

import { PlotFactory, PlotRegistry, PlotHelpers, BasePlot, COMMON_HOVER_STYLE } from '../plot-factory.js';
import { getHeatmapTraceType } from '../plotly-loader.js';
import { getPlotTheme } from '../../shared/plot-theme.js';

const heatmapDefinition = {
  id: 'heatmap',
  name: 'Heatmap',
  description: 'Matrix view of category distributions',
  supportedTypes: ['categorical'],
  supportedLayouts: ['single'],
  supportsLegend: false,

  defaultOptions: { colorscale: 'Blues', showValues: true, normalize: 'row', sortRows: true },

  optionSchema: {
    colorscale: {
      type: 'select', label: 'Colors',
      options: [
        { value: 'Blues', label: 'Blues' }, { value: 'Reds', label: 'Reds' },
        { value: 'Greens', label: 'Greens' }, { value: 'Viridis', label: 'Viridis' },
        { value: 'YlOrRd', label: 'Yellow-Red' }, { value: 'RdBu', label: 'Red-Blue' }
      ]
    },
    normalize: {
      type: 'select', label: 'Normalize',
      options: [
        { value: 'none', label: 'Raw counts' }, { value: 'row', label: 'By row (%)' },
        { value: 'column', label: 'By column (%)' }, { value: 'total', label: 'By total (%)' }
      ]
    },
    showValues: { type: 'checkbox', label: 'Show values' },
    sortRows: { type: 'checkbox', label: 'Sort categories' }
  },

  buildTraces(pageData, options) {
    const { colorscale = 'Blues', showValues = true, normalize = 'row', sortRows = true } = options;
    const theme = getPlotTheme();

    // Collect all categories across all pages
    const globalCounts = new Map();
    for (const pd of pageData) {
      for (const value of pd.values) globalCounts.set(value, (globalCounts.get(value) || 0) + 1);
    }

    const categories = sortRows ? PlotHelpers.sortCategories(globalCounts, 'count') : Array.from(globalCounts.keys());
    const pageNames = pageData.map(pd => pd.pageName);
    const pageCounts = pageData.map(pd => PlotHelpers.countCategories(pd.values));

    // Calculate totals for normalization
    const rowTotals = categories.map(cat => pageCounts.reduce((sum, pc) => sum + (pc.get(cat) || 0), 0));
    const colTotals = pageCounts.map(pc => categories.reduce((sum, cat) => sum + (pc.get(cat) || 0), 0));
    const grandTotal = rowTotals.reduce((a, b) => a + b, 0);

    // Build matrix
    const matrix = [];
    const textMatrix = [];

    for (let i = 0; i < categories.length; i++) {
      const cat = categories[i];
      const row = [], textRow = [];

      for (let j = 0; j < pageData.length; j++) {
        const count = pageCounts[j].get(cat) || 0;
        let value = count, text = count.toString();

        if (normalize === 'row' && rowTotals[i] > 0) { value = (count / rowTotals[i]) * 100; text = `${value.toFixed(1)}%`; }
        else if (normalize === 'column' && colTotals[j] > 0) { value = (count / colTotals[j]) * 100; text = `${value.toFixed(1)}%`; }
        else if (normalize === 'total' && grandTotal > 0) { value = (count / grandTotal) * 100; text = `${value.toFixed(1)}%`; }
        else if (normalize === 'none') { text = PlotHelpers.formatNumber(count, 0); }

        row.push(value);
        textRow.push(showValues ? text : '');
      }

      matrix.push(row);
      textMatrix.push(textRow);
    }

    // Prefer WebGL for large matrices, but use standard heatmap when value
    // annotations are enabled (heatmapgl does not reliably support them).
    const traceType = showValues ? 'heatmap' : getHeatmapTraceType();

    return [{
      type: traceType,
      z: matrix, x: pageNames, y: categories, text: textMatrix,
      texttemplate: showValues ? '%{text}' : '',
      textfont: { family: theme.fontFamily, size: 10 },
      colorscale,
      showscale: true,
      colorbar: {
        thickness: 12, len: 0.8,
        tickfont: { family: theme.fontFamily, size: 9, color: theme.textMuted },
        title: { text: normalize === 'none' ? 'Count' : '%', font: { family: 'Oswald, system-ui, sans-serif', size: 10, color: theme.text } }
      },
      hovertemplate: '%{y}<br>%{x}: %{z:.1f}<extra></extra>',
      hoverlabel: COMMON_HOVER_STYLE
    }];
  },

  buildLayout(pageData, options) {
    const theme = getPlotTheme();
    const layout = BasePlot.createLayout({ showLegend: false });
    const pageNames = pageData.map(pd => pd.pageName);

    layout.xaxis = { title: '', tickangle: pageNames.length > 4 ? -45 : 0, automargin: true, tickfont: { size: 10, color: theme.text } };
    layout.yaxis = { title: '', automargin: true, tickfont: { size: 10, color: theme.text }, autorange: 'reversed' };
    layout.margin = { l: 100, r: 60, t: 30, b: 60 };

    return layout;
  },

  async render(pageData, options, container, layoutEngine) {
    return PlotFactory.render({ definition: this, pageData, options, container, layoutEngine });
  },

  async update(figure, pageData, options, layoutEngine) {
    return PlotFactory.update({ definition: this, figure, pageData, options, layoutEngine });
  },

  exportCSV(pageData, options) {
    const { normalize = 'row', sortRows = true } = options;

    const globalCounts = new Map();
    for (const pd of pageData) for (const value of pd.values) globalCounts.set(value, (globalCounts.get(value) || 0) + 1);

    const categories = sortRows ? PlotHelpers.sortCategories(globalCounts, 'count') : Array.from(globalCounts.keys());
    const pageNames = pageData.map(pd => pd.pageName);
    const pageCounts = pageData.map(pd => PlotHelpers.countCategories(pd.values));
    const rowTotals = categories.map(cat => pageCounts.reduce((sum, pc) => sum + (pc.get(cat) || 0), 0));
    const colTotals = pageCounts.map(pc => categories.reduce((sum, cat) => sum + (pc.get(cat) || 0), 0));
    const grandTotal = rowTotals.reduce((a, b) => a + b, 0);

    const rows = [];
    const columns = ['category', ...pageNames.map(n => `${n}_count`), ...pageNames.map(n => `${n}_normalized`)];

    for (let i = 0; i < categories.length; i++) {
      const cat = categories[i];
      const row = { category: cat };

      for (let j = 0; j < pageData.length; j++) {
        const count = pageCounts[j].get(cat) || 0;
        row[`${pageNames[j]}_count`] = count;

        let normalizedValue = count;
        if (normalize === 'row' && rowTotals[i] > 0) normalizedValue = (count / rowTotals[i]) * 100;
        else if (normalize === 'column' && colTotals[j] > 0) normalizedValue = (count / colTotals[j]) * 100;
        else if (normalize === 'total' && grandTotal > 0) normalizedValue = (count / grandTotal) * 100;
        row[`${pageNames[j]}_normalized`] = normalizedValue.toFixed(2);
      }

      rows.push(row);
    }

    return { rows, columns, metadata: { plotType: 'heatmap', normalize, categoryCount: categories.length, pageCount: pageData.length, exportDate: new Date().toISOString() } };
  }
};

PlotRegistry.register(heatmapDefinition);
export default heatmapDefinition;
