/**
 * Bar Plot for Page Analysis
 *
 * Displays categorical distributions across pages as grouped or stacked bars.
 * Refactored to use PlotFactory for reduced code duplication.
 */

import { PlotFactory, PlotRegistry, PlotHelpers, COMMON_HOVER_STYLE } from '../plot-factory.js';
import { escapeHtml } from '../../../utils/dom-utils.js';

const barplotDefinition = {
  id: 'barplot',
  name: 'Bar Plot',
  description: 'Compare categorical distributions across pages',
  supportedTypes: ['categorical'],
  supportedLayouts: ['side-by-side', 'grouped', 'stacked', 'overlay'],

  defaultOptions: {
    orientation: 'vertical',
    showValues: false,
    sortBy: 'count',
    normalize: false,
    barMode: 'group',
    showLegend: true,
    logScale: false
  },

  optionSchema: {
    orientation: {
      type: 'select',
      label: 'Orientation',
      options: [
        { value: 'vertical', label: 'Vertical' },
        { value: 'horizontal', label: 'Horizontal' }
      ]
    },
    sortBy: {
      type: 'select',
      label: 'Sort by',
      options: [
        { value: 'count', label: 'Count' },
        { value: 'name', label: 'Name' },
        { value: 'none', label: 'Original' }
      ]
    },
    normalize: { type: 'checkbox', label: 'Percentages' },
    logScale: { type: 'checkbox', label: 'Log scale' },
    showValues: { type: 'checkbox', label: 'Value labels' },
    barMode: {
      type: 'select',
      label: 'Arrangement',
      options: [
        { value: 'group', label: 'Grouped' },
        { value: 'stack', label: 'Stacked' },
        { value: 'overlay', label: 'Overlay' }
      ]
    }
  },

  buildTraces(pageData, options, layoutEngine) {
    const { orientation = 'vertical', showValues = false, sortBy = 'count', normalize = false } = options;
    const sortedCategories = PlotFactory.getSortedCategories(pageData, sortBy);

    return PlotFactory.createTraces({
      pageData, options, layoutEngine,
      traceBuilder: (pd, color, i, opts) => {
        const pageCounts = PlotHelpers.countCategories(pd.values);
        const total = pd.cellCount || pd.values.length;
        const values = sortedCategories.map(cat => pageCounts.get(cat) || 0);
        const displayValues = normalize ? values.map(v => total > 0 ? (v / total) * 100 : 0) : values;
        const safePageName = escapeHtml(String(pd.pageName || ''));

        const trace = {
          name: pd.pageName,
          type: 'bar',
          marker: { color, line: { color: 'rgba(0,0,0,0.1)', width: 0.5 } },
          hovertemplate: normalize
            ? `${safePageName}<br>%{${orientation === 'vertical' ? 'x' : 'y'}}: %{${orientation === 'vertical' ? 'y' : 'x'}:.1f}%<extra></extra>`
            : `${safePageName}<br>%{${orientation === 'vertical' ? 'x' : 'y'}}: %{${orientation === 'vertical' ? 'y' : 'x'}:,}<extra></extra>`,
          hoverlabel: COMMON_HOVER_STYLE
        };

        if (orientation === 'vertical') {
          trace.x = sortedCategories;
          trace.y = displayValues;
        } else {
          trace.x = displayValues;
          trace.y = sortedCategories;
          trace.orientation = 'h';
        }

        if (showValues) {
          trace.text = displayValues.map(v => normalize ? v.toFixed(1) + '%' : PlotHelpers.formatNumber(v, 0));
          trace.textposition = 'outside';
          trace.textfont = { size: 9 };
        }

        return trace;
      }
    });
  },

  buildLayout(pageData, options) {
    const { orientation = 'vertical', sortBy = 'count', normalize = false, barMode = 'group', logScale = false } = options;
    const sortedCategories = PlotFactory.getSortedCategories(pageData, sortBy);
    const layout = PlotFactory.createLayout({ pageData, options, custom: { barmode: barMode } });
    PlotFactory.configureCategoricalAxes(layout, { categories: sortedCategories, options });
    return layout;
  },

  async render(pageData, options, container, layoutEngine) {
    return PlotFactory.render({ definition: this, pageData, options, container, layoutEngine });
  },

  async update(figure, pageData, options, layoutEngine) {
    return PlotFactory.update({ definition: this, figure, pageData, options, layoutEngine });
  },

  exportCSV(pageData, options) {
    const { sortBy = 'count' } = options;
    return PlotFactory.exportCategoricalCSV(pageData, {
      categories: PlotFactory.getSortedCategories(pageData, sortBy),
      metadata: { plotType: 'barplot' }
    });
  }
};

PlotRegistry.register(barplotDefinition);
export default barplotDefinition;
