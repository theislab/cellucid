/**
 * Histogram for Page Analysis
 *
 * Displays binned distribution of continuous values across pages.
 */

import { PlotRegistry, PlotHelpers, getPageColor } from '../plot-registry.js';
import { createMinimalPlotly, getPlotlyConfig } from '../plotly-loader.js';

const histogramDefinition = {
  id: 'histogram',
  name: 'Histogram',
  description: 'Compare binned value distributions across pages',
  supportedDataTypes: ['continuous'],
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
    nbins: {
      type: 'range',
      label: 'Bins',
      min: 5,
      max: 100,
      step: 5
    },
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
    logX: {
      type: 'checkbox',
      label: 'Log X'
    },
    logY: {
      type: 'checkbox',
      label: 'Log Y'
    },
    cumulative: {
      type: 'checkbox',
      label: 'Cumulative'
    }
  },

  /**
   * Render histogram
   * @param {Object[]} pageData - Array of page data objects
   * @param {Object} options - Plot options
   * @param {HTMLElement} container - Container element
   * @param {LayoutEngine} layoutEngine - Layout engine instance
   * @returns {Promise<Object>} Plotly figure reference
   */
  async render(pageData, options, container, layoutEngine) {
    const {
      nbins = 20,
      histnorm = '',
      cumulative = false,
      barmode = 'overlay',
      opacity = 0.7,
      logX = false,
      logY = false
    } = options;

    const traces = [];

    // Calculate global min/max for consistent binning
    let globalMin = Infinity;
    let globalMax = -Infinity;
    for (const pd of pageData) {
      for (const v of pd.values) {
        if (typeof v === 'number' && !Number.isNaN(v)) {
          if (v < globalMin) globalMin = v;
          if (v > globalMax) globalMax = v;
        }
      }
    }

    // Create histogram traces
    for (let i = 0; i < pageData.length; i++) {
      const pd = pageData[i];
      const color = layoutEngine?.getPageColor(pd.pageId) || getPageColor(i);

      // Filter to numeric values only
      const numericValues = pd.values.filter(v => typeof v === 'number' && !Number.isNaN(v));

      if (numericValues.length === 0) {
        continue;
      }

      const trace = {
        type: 'histogram',
        name: pd.pageName,
        x: numericValues,
        nbinsx: nbins,
        histnorm: histnorm,
        cumulative: { enabled: cumulative },
        marker: {
          color: color,
          line: {
            color: 'rgba(0,0,0,0.1)',
            width: 0.5
          }
        },
        opacity: barmode === 'overlay' ? opacity : 1,
        hovertemplate: histnorm === 'percent' || histnorm === 'probability'
          ? `${pd.pageName}<br>%{x}: %{y:.1f}%<extra></extra>`
          : `${pd.pageName}<br>%{x}: %{y}<extra></extra>`
      };

      // Set bin range for consistent alignment across pages
      if (isFinite(globalMin) && isFinite(globalMax)) {
        trace.xbins = {
          start: globalMin,
          end: globalMax,
          size: (globalMax - globalMin) / nbins
        };
      }

      traces.push(trace);
    }

    // Build layout
    const layout = PlotHelpers.createBaseLayout({
      showLegend: pageData.length > 1,
      barmode: barmode
    });

    const variableName = pageData[0]?.variableInfo?.name || 'Value';

    layout.xaxis = {
      title: variableName,
      automargin: true,
      type: logX ? 'log' : 'linear'
    };

    let yLabel = 'Count';
    if (histnorm === 'percent') yLabel = 'Percent';
    else if (histnorm === 'probability') yLabel = 'Probability';
    else if (histnorm === 'density') yLabel = 'Density';

    layout.yaxis = {
      title: yLabel,
      zeroline: true,
      type: logY ? 'log' : 'linear'
    };

    // Render with Plotly (lazy loaded)
    const config = getPlotlyConfig();

    try {
      const Plotly = await createMinimalPlotly();
      return await Plotly.newPlot(container, traces, layout, config);
    } catch (err) {
      console.error('[Histogram] Render error:', err);
      throw new Error(`Failed to render histogram: ${err.message}`);
    }
  },

  /**
   * Update existing plot
   */
  update(figure, pageData, options, layoutEngine) {
    return this.render(pageData, options, figure, layoutEngine);
  }
};

// Register the plot type
PlotRegistry.register(histogramDefinition);

export default histogramDefinition;
