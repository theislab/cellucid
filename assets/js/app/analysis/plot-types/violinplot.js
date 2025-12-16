/**
 * Violin Plot for Page Analysis
 *
 * Displays distribution of continuous values using kernel density estimation,
 * providing a richer view of the data distribution than box plots.
 */

import { PlotRegistry, PlotHelpers, getPageColor } from '../plot-registry.js';
import { createMinimalPlotly, getPlotlyConfig } from '../plotly-loader.js';

const violinplotDefinition = {
  id: 'violinplot',
  name: 'Violin Plot',
  description: 'Compare value distributions with density visualization',
  supportedDataTypes: ['continuous'],
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
    showBox: {
      type: 'checkbox',
      label: 'Box inside'
    },
    showMeanLine: {
      type: 'checkbox',
      label: 'Mean line'
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
    markerSize: {
      type: 'range',
      label: 'Point Size',
      min: 2,
      max: 10,
      step: 1,
      showWhen: (opts) => opts.showPoints !== 'none'
    },
    logScale: {
      type: 'checkbox',
      label: 'Log scale'
    },
    showGrid: {
      type: 'checkbox',
      label: 'Grid lines'
    }
  },

  /**
   * Render violin plot
   * @param {Object[]} pageData - Array of page data objects
   * @param {Object} options - Plot options
   * @param {HTMLElement} container - Container element
   * @param {LayoutEngine} layoutEngine - Layout engine instance
   * @returns {Promise<Object>} Plotly figure reference
   */
  async render(pageData, options, container, layoutEngine) {
    const {
      orientation = 'vertical',
      showBox = true,
      showMeanLine = false,
      showPoints = 'none',
      side = 'both',
      logScale = false,
      showGrid = true,
      markerSize = 3,
      violinWidth = 80
    } = options;

    const traces = [];
    const widthValue = violinWidth / 100;

    for (let i = 0; i < pageData.length; i++) {
      const pd = pageData[i];
      const color = layoutEngine?.getPageColor(pd.pageId) || getPageColor(i);

      // Filter to numeric values only
      const numericValues = pd.values.filter(v => typeof v === 'number' && !Number.isNaN(v));

      if (numericValues.length < 2) {
        continue; // Need at least 2 points for violin
      }

      const trace = {
        type: 'violin',
        name: pd.pageName,
        side: side,
        spanmode: 'soft',
        meanline: { visible: showMeanLine },
        box: { visible: showBox },
        points: showPoints === 'none' ? false : showPoints,
        jitter: showPoints === 'all' ? 0.1 : 0,
        pointpos: 0,
        scalemode: 'count',
        width: widthValue,
        marker: {
          color: color,
          size: markerSize,
          opacity: 0.6
        },
        line: {
          color: color,
          width: 1.5
        },
        fillcolor: color + '60',
        hoverinfo: 'y+name',
        hoverlabel: {
          bgcolor: color,
          font: { color: '#ffffff' }
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
      showLegend: pageData.length > 1
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

    // Violin mode for overlapping
    layout.violinmode = 'overlay';
    layout.violingap = 0.1;
    layout.violingroupgap = 0.2;

    // Render with Plotly (lazy loaded)
    const config = getPlotlyConfig();

    try {
      const Plotly = await createMinimalPlotly();
      return await Plotly.newPlot(container, traces, layout, config);
    } catch (err) {
      console.error('[ViolinPlot] Render error:', err);
      throw new Error(`Failed to render violin plot: ${err.message}`);
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
PlotRegistry.register(violinplotDefinition);

export default violinplotDefinition;
