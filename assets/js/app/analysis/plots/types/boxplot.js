/**
 * Box Plot for Page Analysis
 *
 * Displays distribution of continuous values across pages using box-and-whisker plots.
 * Refactored to use PlotFactory for reduced code duplication.
 */

import { PlotFactory, PlotRegistry } from '../plot-factory.js';

const boxplotDefinition = {
  id: 'boxplot',
  name: 'Box Plot',
  description: 'Compare continuous value distributions across pages',
  supportedDataTypes: ['continuous'],
  supportedLayouts: ['side-by-side', 'grouped', 'overlay'],

  defaultOptions: {
    orientation: 'vertical',
    showPoints: 'outliers',
    jitter: 30,
    markerSize: 4,
    notched: false,
    showMean: false,
    logScale: false,
    showGrid: true,
    boxWidth: 60
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
    showPoints: {
      type: 'select',
      label: 'Points',
      options: [
        { value: 'none', label: 'None' },
        { value: 'outliers', label: 'Outliers' },
        { value: 'all', label: 'All' }
      ]
    },
    jitter: {
      type: 'range',
      label: 'Jitter',
      min: 0,
      max: 100,
      step: 10,
      showWhen: (opts) => opts.showPoints === 'all'
    },
    markerSize: {
      type: 'range',
      label: 'Point Size',
      min: 2,
      max: 12,
      step: 1,
      showWhen: (opts) => opts.showPoints !== 'none'
    },
    boxWidth: {
      type: 'range',
      label: 'Box Width',
      min: 20,
      max: 100,
      step: 10
    },
    logScale: { type: 'checkbox', label: 'Log scale' },
    notched: { type: 'checkbox', label: 'Notches' },
    showMean: { type: 'checkbox', label: 'Show mean ± SD' },
    showGrid: { type: 'checkbox', label: 'Grid lines' }
  },

  buildTraces(pageData, options, layoutEngine) {
    return PlotFactory.createTraces({
      pageData,
      options,
      layoutEngine,
      filterNumeric: true,
      minValues: 1,
      traceBuilder: (pd, color, i, opts) =>
        PlotFactory.buildDistributionTrace({ type: 'box', pd, color, options: opts })
    });
  },

  buildLayout(pageData, options) {
    const layout = PlotFactory.createLayout({ pageData, options });
    PlotFactory.configureDistributionAxes(layout, { pageData, options });
    layout.boxmode = 'group';
    return layout;
  },

  async render(pageData, options, container, layoutEngine) {
    return PlotFactory.render({ definition: this, pageData, options, container, layoutEngine });
  },

  async update(figure, pageData, options, layoutEngine) {
    return PlotFactory.update({ definition: this, figure, pageData, options, layoutEngine });
  },

  exportCSV(pageData, options) {
    return PlotFactory.exportDistributionCSV(pageData, { metadata: { plotType: 'boxplot' } });
  }
};

PlotRegistry.register(boxplotDefinition);
export default boxplotDefinition;
