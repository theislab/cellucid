/**
 * Box Plot for Page Analysis
 *
 * Displays distribution of continuous values across pages using box-and-whisker plots.
 */

import { PlotRegistry, PlotHelpers, getPageColor } from '../plot-registry.js';
import { createMinimalPlotly, getPlotlyConfig } from '../plotly-loader.js';

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
    logScale: {
      type: 'checkbox',
      label: 'Log scale'
    },
    notched: {
      type: 'checkbox',
      label: 'Notches'
    },
    showMean: {
      type: 'checkbox',
      label: 'Show mean ± SD'
    },
    showGrid: {
      type: 'checkbox',
      label: 'Grid lines'
    }
  },

  /**
   * Render box plot
   * @param {Object[]} pageData - Array of page data objects
   * @param {Object} options - Plot options
   * @param {HTMLElement} container - Container element
   * @param {LayoutEngine} layoutEngine - Layout engine instance
   * @returns {Promise<Object>} Plotly figure reference
   */
  async render(pageData, options, container, layoutEngine) {
    const {
      orientation = 'vertical',
      showPoints = 'outliers',
      jitter = 30,
      markerSize = 4,
      notched = false,
      showMean = false,
      logScale = false,
      showLegend = true,
      showGrid = true,
      boxWidth = 60
    } = options;

    const traces = [];

    // Convert percentage values to decimals for Plotly
    const jitterValue = showPoints === 'all' ? jitter / 100 : 0;
    const widthValue = boxWidth / 100;

    for (let i = 0; i < pageData.length; i++) {
      const pd = pageData[i];
      const color = layoutEngine?.getPageColor(pd.pageId) || getPageColor(i);

      // Filter to numeric values only
      const numericValues = pd.values.filter(v => typeof v === 'number' && !Number.isNaN(v));

      if (numericValues.length === 0) {
        continue; // Skip empty datasets
      }

      const trace = {
        type: 'box',
        name: pd.pageName,
        boxpoints: showPoints === 'none' ? false : showPoints,
        jitter: jitterValue,
        pointpos: 0,
        notched: notched,
        boxmean: showMean ? 'sd' : false,
        width: widthValue,
        marker: {
          color: color,
          size: markerSize,
          opacity: 0.8,
          line: { width: 0 }
        },
        line: {
          color: color,
          width: 2
        },
        fillcolor: color + '25', // Subtle fill
        hoverinfo: 'y+name',
        hoverlabel: {
          bgcolor: '#111827',
          bordercolor: '#111827',
          font: { family: 'Inter, system-ui, sans-serif', size: 12, color: '#ffffff' }
        }
      };

      if (orientation === 'vertical') {
        trace.y = numericValues;
        trace.x = new Array(numericValues.length).fill(pd.pageName);
      } else {
        trace.x = numericValues;
        trace.y = new Array(numericValues.length).fill(pd.pageName);
        trace.orientation = 'h';
      }

      traces.push(trace);
    }

    // Build layout
    const layout = PlotHelpers.createBaseLayout({
      showLegend: showLegend && pageData.length > 1
    });

    const variableName = pageData[0]?.variableInfo?.name || 'Value';
    const gridColor = showGrid ? '#f3f4f6' : 'transparent';

    if (orientation === 'vertical') {
      layout.xaxis = {
        title: '',
        automargin: true,
        showgrid: false
      };
      layout.yaxis = {
        title: variableName,
        zeroline: false,
        type: logScale ? 'log' : 'linear',
        showgrid: showGrid,
        gridcolor: gridColor
      };
    } else {
      layout.xaxis = {
        title: variableName,
        zeroline: false,
        type: logScale ? 'log' : 'linear',
        showgrid: showGrid,
        gridcolor: gridColor
      };
      layout.yaxis = {
        title: '',
        automargin: true,
        showgrid: false
      };
      layout.margin = { l: 100, r: 20, t: 30, b: 50 };
    }

    // Add box mode for grouped boxes
    layout.boxmode = 'group';

    // Render with Plotly (lazy loaded)
    const config = getPlotlyConfig();

    try {
      const Plotly = await createMinimalPlotly();
      return await Plotly.newPlot(container, traces, layout, config);
    } catch (err) {
      console.error('[BoxPlot] Render error:', err);
      throw new Error(`Failed to render box plot: ${err.message}`);
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
PlotRegistry.register(boxplotDefinition);

export default boxplotDefinition;
