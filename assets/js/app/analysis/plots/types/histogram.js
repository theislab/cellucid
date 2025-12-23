/**
 * Histogram for Page Analysis
 *
 * Displays binned distribution of continuous values across pages.
 * Refactored to use PlotFactory for reduced code duplication.
 */

import { PlotFactory, PlotRegistry, BasePlot, COMMON_HOVER_STYLE } from '../plot-factory.js';
import { escapeHtml } from '../../../utils/dom-utils.js';

const histogramDefinition = {
  id: 'histogram',
  name: 'Histogram',
  description: 'Compare binned value distributions across pages',
  supportedTypes: ['continuous'],
  supportedLayouts: ['side-by-side', 'overlay', 'stacked'],

  defaultOptions: {
    nbins: 20,
    histnorm: '',
    cumulative: false,
    barmode: 'overlay',
    opacity: 0.7,
    logX: false,
    logY: false
  },

  optionSchema: {
    nbins: { type: 'range', label: 'Bins', min: 5, max: 100, step: 5 },
    histnorm: {
      type: 'select',
      label: 'Normalize',
      options: [
        { value: '', label: 'Count' },
        { value: 'percent', label: 'Percent' },
        { value: 'probability', label: 'Probability' },
        { value: 'density', label: 'Density' }
      ]
    },
    barmode: {
      type: 'select',
      label: 'Mode',
      options: [
        { value: 'overlay', label: 'Overlay' },
        { value: 'stack', label: 'Stacked' },
        { value: 'group', label: 'Grouped' }
      ]
    },
    logX: { type: 'checkbox', label: 'Log X' },
    logY: { type: 'checkbox', label: 'Log Y' },
    cumulative: { type: 'checkbox', label: 'Cumulative' }
  },

  buildTraces(pageData, options, layoutEngine) {
    const { nbins = 20, histnorm = '', cumulative = false, barmode = 'overlay', opacity = 0.7 } = options;
    const { min: globalMin, max: globalMax } = BasePlot.getGlobalRange(pageData);

    return PlotFactory.createTraces({
      pageData,
      options,
      layoutEngine,
      filterNumeric: true,
      minValues: 1,
      traceBuilder: (pd, color, i, opts) => {
        const safePageName = escapeHtml(String(pd.pageName || ''));
        const trace = {
          type: 'histogram',
          name: pd.pageName,
          x: pd.values,
          nbinsx: nbins,
          histnorm,
          cumulative: { enabled: cumulative },
          marker: { color, line: { color: 'rgba(0,0,0,0.1)', width: 0.5 } },
          opacity: barmode === 'overlay' ? opacity : 1,
          hovertemplate: histnorm === 'percent' || histnorm === 'probability'
            ? `${safePageName}<br>%{x}: %{y:.1f}%<extra></extra>`
            : `${safePageName}<br>%{x}: %{y}<extra></extra>`,
          hoverlabel: COMMON_HOVER_STYLE
        };

        if (isFinite(globalMin) && isFinite(globalMax)) {
          trace.xbins = { start: globalMin, end: globalMax, size: (globalMax - globalMin) / nbins };
        }

        return trace;
      }
    });
  },

  buildLayout(pageData, options) {
    const { barmode = 'overlay', histnorm = '' } = options;
    const layout = PlotFactory.createLayout({ pageData, options, custom: { barmode } });
    PlotFactory.configureHistogramAxes(layout, { pageData, options });
    return layout;
  },

  async render(pageData, options, container, layoutEngine) {
    return PlotFactory.render({ definition: this, pageData, options, container, layoutEngine });
  },

  async update(figure, pageData, options, layoutEngine) {
    return PlotFactory.update({ definition: this, figure, pageData, options, layoutEngine });
  },

  exportCSV(pageData, options) {
    return PlotFactory.exportHistogramCSV(pageData, options);
  }
};

PlotRegistry.register(histogramDefinition);
export default histogramDefinition;
