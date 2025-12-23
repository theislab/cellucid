/**
 * Pie/Donut Chart Plot Type
 *
 * Shows proportions within a single page or side-by-side for multiple pages.
 * Supports donut variant for better readability.
 * Refactored to use PlotFactory for reduced code duplication.
 */

import { PlotFactory, PlotRegistry, BasePlot, COMMON_HOVER_STYLE, createMinimalPlotly } from '../plot-factory.js';
import { getPlotTheme } from '../../shared/plot-theme.js';
import { escapeHtml } from '../../../utils/dom-utils.js';

/**
 * Process categories for a page (count, sort, limit)
 */
function processCategories(values, options) {
  const counts = new Map();
  for (const val of values) counts.set(val, (counts.get(val) || 0) + 1);

  let entries = Array.from(counts.entries());
  if (options.sortByValue) entries.sort((a, b) => b[1] - a[1]);

  if (entries.length > options.maxCategories) {
    const topEntries = entries.slice(0, options.maxCategories - 1);
    const otherSum = entries.slice(options.maxCategories - 1).reduce((s, e) => s + e[1], 0);
    entries = [...topEntries, ['Other', otherSum]];
  }

  return { labels: entries.map(e => e[0]), values: entries.map(e => e[1]) };
}

const pieplotDefinition = {
  id: 'pieplot',
  name: 'Pie / Donut',
  description: 'Proportions within pages',
  supportedTypes: ['categorical'],
  supportedLayouts: ['side-by-side', 'grid'],

  defaultOptions: { donut: true, showPercent: true, showLabels: true, maxCategories: 10, sortByValue: true },

  optionSchema: {
    donut: { type: 'checkbox', label: 'Donut style' },
    showPercent: { type: 'checkbox', label: 'Show percentages' },
    showLabels: { type: 'checkbox', label: 'Show category labels' },
    maxCategories: { type: 'range', label: 'Max categories', min: 3, max: 20, step: 1 },
    sortByValue: { type: 'checkbox', label: 'Sort by value' }
  },

  buildTraces(pageData, options) {
    const theme = getPlotTheme();
    const numPages = pageData.length;
    const cols = Math.min(numPages, 3);
    const rows = Math.ceil(numPages / cols);
    const traces = [];

    pageData.forEach((pd, index) => {
      const { labels, values } = processCategories(pd.values, options);
      const col = index % cols;
      const row = Math.floor(index / cols);

      const xGap = 0.05, yGap = 0.08;
      const xSize = (1 - xGap * (cols - 1)) / cols;
      const ySize = (1 - yGap * (rows - 1)) / rows;
      const xStart = col * (xSize + xGap);
      const yStart = 1 - (row + 1) * (ySize + yGap) + yGap;

      traces.push({
        type: 'pie',
        labels, values,
        name: pd.pageName,
        hole: options.donut ? 0.4 : 0,
        domain: { x: [xStart, xStart + xSize], y: [yStart, yStart + ySize] },
        textinfo: options.showPercent && options.showLabels ? 'label+percent'
          : options.showPercent ? 'percent' : options.showLabels ? 'label' : 'none',
        textposition: 'inside',
        insidetextorientation: 'radial',
        textfont: { family: theme.fontFamily, size: 10, color: '#ffffff' },
        marker: { line: { color: theme.plotBg, width: 1 } },
        hovertemplate: '%{label}: %{value} (%{percent})<extra>' + escapeHtml(pd.pageName) + '</extra>',
        hoverlabel: COMMON_HOVER_STYLE,
        showlegend: index === 0
      });
    });

    return traces;
  },

  buildLayout(pageData, options) {
    const theme = getPlotTheme();
    const numPages = pageData.length;
    const cols = Math.min(numPages, 3);
    const rows = Math.ceil(numPages / cols);

    const layout = BasePlot.createLayout({ showLegend: true });
    layout.legend = { orientation: 'h', x: 0.5, xanchor: 'center', y: -0.05, font: { family: theme.fontFamily, size: theme.legendFontSize, color: theme.legend.text } };
    layout.margin = { l: 20, r: 20, t: 40, b: 40 };
    layout.height = rows * 200 + 60;

    // Add page name annotations
    layout.annotations = pageData.map((pd, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const xGap = 0.05, yGap = 0.08;
      const xSize = (1 - xGap * (cols - 1)) / cols;
      const ySize = (1 - yGap * (rows - 1)) / rows;
      const xStart = col * (xSize + xGap);
      const yStart = 1 - (row + 1) * (ySize + yGap) + yGap;

      return {
        text: `<b>${escapeHtml(pd.pageName ?? '')}</b>`,
        x: xStart + xSize / 2,
        y: yStart + ySize + 0.02,
        xref: 'paper', yref: 'paper',
        showarrow: false,
        font: { family: 'Oswald, system-ui, sans-serif', size: 11, color: theme.textStrong }
      };
    });

    return layout;
  },

  async render(pageData, options, container, layoutEngine) {
    return PlotFactory.render({ definition: this, pageData, options, container, layoutEngine });
  },

  async update(figure, pageData, options, layoutEngine) {
    // Pie charts need full re-render when domain layouts change
    try {
      const Plotly = await createMinimalPlotly();
      Plotly.purge?.(figure);
    } catch (_purgeErr) {
      // Ignore purge failures
    }
    return this.render(pageData, options, figure, layoutEngine);
  },

  exportCSV(pageData, options) {
    const rows = [];
    for (const pd of pageData) {
      const { labels, values } = processCategories(pd.values, options);
      const total = values.reduce((s, v) => s + v, 0);
      for (let i = 0; i < labels.length; i++) {
        rows.push({ page: pd.pageName, category: labels[i], count: values[i], percent: ((values[i] / total) * 100).toFixed(2) });
      }
    }
    return { rows, columns: ['page', 'category', 'count', 'percent'], metadata: { plotType: 'pieplot', pageCount: pageData.length, maxCategories: options.maxCategories, exportDate: new Date().toISOString() } };
  }
};

PlotRegistry.register(pieplotDefinition);
export default pieplotDefinition;
