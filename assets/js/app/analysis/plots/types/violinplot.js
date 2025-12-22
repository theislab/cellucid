/**
 * Violin Plot for Page Analysis
 *
 * Displays distribution of continuous values using kernel density estimation,
 * providing a richer view of the data distribution than box plots.
 * Refactored to use PlotFactory for reduced code duplication.
 */

import { PlotFactory, PlotRegistry } from '../plot-factory.js';

const violinplotDefinition = {
  id: 'violinplot',
  name: 'Violin Plot',
  description: 'Compare value distributions with density visualization',
  supportedTypes: ['continuous'],
  supportedLayouts: ['side-by-side', 'grouped', 'overlay'],

  defaultOptions: {
    orientation: 'vertical',
    showBox: true,
    showMeanLine: false,
    showPoints: 'none',
    side: 'both',
    logScale: false,
    showGrid: true,
    markerSize: 3,
    violinWidth: 80
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
    side: {
      type: 'select',
      label: 'Violin Side',
      options: [
        { value: 'both', label: 'Both sides' },
        { value: 'positive', label: 'Right only' },
        { value: 'negative', label: 'Left only' }
      ]
    },
    violinWidth: {
      type: 'range',
      label: 'Width',
      min: 40,
      max: 100,
      step: 10
    },
    showBox: { type: 'checkbox', label: 'Box inside' },
    showMeanLine: { type: 'checkbox', label: 'Mean line' },
    showPoints: {
      type: 'select',
      label: 'Points',
      options: [
        { value: 'none', label: 'None' },
        { value: 'outliers', label: 'Outliers' },
        { value: 'all', label: 'All' }
      ]
    },
    markerSize: {
      type: 'range',
      label: 'Point Size',
      min: 2,
      max: 10,
      step: 1,
      showWhen: (opts) => opts.showPoints !== 'none'
    },
    logScale: { type: 'checkbox', label: 'Log scale' },
    showGrid: { type: 'checkbox', label: 'Grid lines' }
  },

  buildTraces(pageData, options, layoutEngine) {
    return PlotFactory.createTraces({
      pageData,
      options,
      layoutEngine,
      filterNumeric: true,
      minValues: 2, // Need at least 2 points for violin
      traceBuilder: (pd, color, i, opts) =>
        PlotFactory.buildDistributionTrace({ type: 'violin', pd, color, options: opts })
    });
  },

  buildLayout(pageData, options) {
    const layout = PlotFactory.createLayout({ pageData, options });
    PlotFactory.configureDistributionAxes(layout, { pageData, options });
    layout.violinmode = 'overlay';
    layout.violingap = 0.1;
    layout.violingroupgap = 0.2;
    return layout;
  },

  async render(pageData, options, container, layoutEngine) {
    return PlotFactory.render({ definition: this, pageData, options, container, layoutEngine });
  },

  async update(figure, pageData, options, layoutEngine) {
    return PlotFactory.update({ definition: this, figure, pageData, options, layoutEngine });
  },

  exportCSV(pageData, options) {
    return PlotFactory.exportDistributionCSV(pageData, {
      metadata: {
        plotType: 'violinplot',
        variable: pageData[0]?.variableInfo?.name || 'Value'
      }
    });
  }
};

PlotRegistry.register(violinplotDefinition);
export default violinplotDefinition;
