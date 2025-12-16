/**
 * Bar Plot for Page Analysis
 *
 * Displays categorical distributions across pages as grouped or stacked bars.
 */

import { PlotRegistry, PlotHelpers, getPageColor } from '../plot-registry.js';
import { createMinimalPlotly, getPlotlyConfig } from '../plotly-loader.js';

const barplotDefinition = {
  id: 'barplot',
  name: 'Bar Plot',
  description: 'Compare categorical distributions across pages',
  supportedDataTypes: ['categorical'],
  supportedLayouts: ['side-by-side', 'grouped', 'stacked', 'overlay'],

  defaultOptions: {
    orientation: 'vertical',
    showValues: false,
    sortBy: 'count', // 'count', 'name', 'none'
    normalize: false, // Show as percentages
    barMode: 'group', // 'group', 'stack', 'overlay'
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
    normalize: {
      type: 'checkbox',
      label: 'Percentages'
    },
    logScale: {
      type: 'checkbox',
      label: 'Log scale'
    },
    showValues: {
      type: 'checkbox',
      label: 'Value labels'
    },
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

  /**
   * Render bar plot
   * @param {Object[]} pageData - Array of page data objects
   * @param {Object} options - Plot options
   * @param {HTMLElement} container - Container element
   * @param {LayoutEngine} layoutEngine - Layout engine instance
   * @returns {Promise<Object>} Plotly figure reference
   */
  async render(pageData, options, container, layoutEngine) {
    const {
      orientation = 'vertical',
      showValues = false,
      sortBy = 'count',
      normalize = false,
      barMode = 'group',
      showLegend = true,
      logScale = false
    } = options;

    // Count categories across all pages to get consistent ordering
    const globalCounts = new Map();
    for (const pd of pageData) {
      for (const value of pd.values) {
        globalCounts.set(value, (globalCounts.get(value) || 0) + 1);
      }
    }

    // Sort categories
    const sortedCategories = PlotHelpers.sortCategories(globalCounts, sortBy);

    // Build traces
    const traces = [];

    for (let i = 0; i < pageData.length; i++) {
      const pd = pageData[i];
      const pageCounts = PlotHelpers.countCategories(pd.values);
      const total = pd.cellCount;

      // Get values in sorted order
      const values = sortedCategories.map(cat => pageCounts.get(cat) || 0);
      const displayValues = normalize
        ? values.map(v => total > 0 ? (v / total) * 100 : 0)
        : values;

      const color = layoutEngine?.getPageColor(pd.pageId) || getPageColor(i);

      const trace = {
        name: pd.pageName,
        type: 'bar',
        marker: {
          color: color,
          line: {
            color: 'rgba(0,0,0,0.1)',
            width: 0.5
          }
        },
        hovertemplate: normalize
          ? `${pd.pageName}<br>%{${orientation === 'vertical' ? 'x' : 'y'}}: %{${orientation === 'vertical' ? 'y' : 'x'}:.1f}%<extra></extra>`
          : `${pd.pageName}<br>%{${orientation === 'vertical' ? 'x' : 'y'}}: %{${orientation === 'vertical' ? 'y' : 'x'}:,}<extra></extra>`
      };

      if (orientation === 'vertical') {
        trace.x = sortedCategories;
        trace.y = displayValues;
      } else {
        trace.x = displayValues;
        trace.y = sortedCategories;
        trace.orientation = 'h';
      }

      // Add text labels if requested
      if (showValues) {
        trace.text = displayValues.map(v =>
          normalize ? v.toFixed(1) + '%' : PlotHelpers.formatNumber(v, 0)
        );
        trace.textposition = 'outside';
        trace.textfont = { size: 9 };
      }

      traces.push(trace);
    }

    // Build layout
    const layout = PlotHelpers.createBaseLayout({
      showLegend: showLegend && pageData.length > 1,
      barmode: barMode
    });

    const axisLabel = normalize ? 'Percentage (%)' : 'Count';

    if (orientation === 'vertical') {
      layout.xaxis = {
        title: '',
        tickangle: sortedCategories.length > 8 ? -45 : 0,
        automargin: true
      };
      layout.yaxis = {
        title: axisLabel,
        type: logScale ? 'log' : 'linear'
      };
    } else {
      layout.xaxis = {
        title: axisLabel,
        type: logScale ? 'log' : 'linear'
      };
      layout.yaxis = {
        title: '',
        automargin: true
      };
    }

    // Adjust margins for labels
    if (orientation === 'horizontal') {
      layout.margin = { l: 100, r: 20, t: 30, b: 50 };
    }

    // Render with Plotly (lazy loaded)
    const config = getPlotlyConfig();

    try {
      const Plotly = await createMinimalPlotly();
      return await Plotly.newPlot(container, traces, layout, config);
    } catch (err) {
      console.error('[BarPlot] Render error:', err);
      throw new Error(`Failed to render bar plot: ${err.message}`);
    }
  },

  /**
   * Update existing plot
   */
  update(figure, pageData, options, layoutEngine) {
    // For now, just re-render
    return this.render(pageData, options, figure, layoutEngine);
  }
};

// Register the plot type
PlotRegistry.register(barplotDefinition);

export default barplotDefinition;
