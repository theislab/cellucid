/**
 * Heatmap Plot Type
 *
 * Matrix view comparing multiple categorical variables across pages.
 * Shows category counts as a color-coded grid.
 */

import { PlotRegistry, PlotHelpers, getPageColor } from '../plot-registry.js';
import { createMinimalPlotly, getPlotlyConfig } from '../plotly-loader.js';

const heatmapDefinition = {
  id: 'heatmap',
  name: 'Heatmap',
  description: 'Matrix view of category distributions',
  supportedDataTypes: ['categorical'],
  supportedLayouts: ['single'],

  defaultOptions: {
    colorscale: 'Blues',
    showValues: true,
    normalize: 'row', // 'none', 'row', 'column', 'total'
    sortRows: true
  },

  optionSchema: {
    colorscale: {
      type: 'select',
      label: 'Colors',
      options: [
        { value: 'Blues', label: 'Blues' },
        { value: 'Reds', label: 'Reds' },
        { value: 'Greens', label: 'Greens' },
        { value: 'Viridis', label: 'Viridis' },
        { value: 'YlOrRd', label: 'Yellow-Red' },
        { value: 'RdBu', label: 'Red-Blue' }
      ]
    },
    normalize: {
      type: 'select',
      label: 'Normalize',
      options: [
        { value: 'none', label: 'Raw counts' },
        { value: 'row', label: 'By row (%)' },
        { value: 'column', label: 'By column (%)' },
        { value: 'total', label: 'By total (%)' }
      ]
    },
    showValues: {
      type: 'checkbox',
      label: 'Show values'
    },
    sortRows: {
      type: 'checkbox',
      label: 'Sort categories'
    }
  },

  /**
   * Render heatmap
   * @param {Object[]} pageData - Array of page data objects
   * @param {Object} options - Plot options
   * @param {HTMLElement} container - Container element
   * @param {LayoutEngine} layoutEngine - Layout engine instance
   * @returns {Promise<Object>} Plotly figure reference
   */
  async render(pageData, options, container, layoutEngine) {
    const {
      colorscale = 'Blues',
      showValues = true,
      normalize = 'row',
      sortRows = true
    } = options;

    // Collect all categories across all pages
    const globalCounts = new Map();
    for (const pd of pageData) {
      for (const value of pd.values) {
        globalCounts.set(value, (globalCounts.get(value) || 0) + 1);
      }
    }

    // Sort categories by total count or alphabetically
    let categories;
    if (sortRows) {
      categories = PlotHelpers.sortCategories(globalCounts, 'count');
    } else {
      categories = Array.from(globalCounts.keys());
    }

    // Build the matrix: rows = categories, columns = pages
    const pageNames = pageData.map(pd => pd.pageName);
    const matrix = [];
    const textMatrix = [];

    // Calculate counts for each category in each page
    const pageCounts = pageData.map(pd => {
      const counts = PlotHelpers.countCategories(pd.values);
      return counts;
    });

    // Calculate totals for normalization
    const rowTotals = categories.map(cat => {
      return pageCounts.reduce((sum, pc) => sum + (pc.get(cat) || 0), 0);
    });
    const colTotals = pageCounts.map(pc => {
      return categories.reduce((sum, cat) => sum + (pc.get(cat) || 0), 0);
    });
    const grandTotal = rowTotals.reduce((a, b) => a + b, 0);

    // Build matrix with normalization
    for (let i = 0; i < categories.length; i++) {
      const cat = categories[i];
      const row = [];
      const textRow = [];

      for (let j = 0; j < pageData.length; j++) {
        const count = pageCounts[j].get(cat) || 0;
        let value = count;
        let text = count.toString();

        switch (normalize) {
          case 'row':
            value = rowTotals[i] > 0 ? (count / rowTotals[i]) * 100 : 0;
            text = `${value.toFixed(1)}%`;
            break;
          case 'column':
            value = colTotals[j] > 0 ? (count / colTotals[j]) * 100 : 0;
            text = `${value.toFixed(1)}%`;
            break;
          case 'total':
            value = grandTotal > 0 ? (count / grandTotal) * 100 : 0;
            text = `${value.toFixed(1)}%`;
            break;
          default:
            text = PlotHelpers.formatNumber(count, 0);
        }

        row.push(value);
        textRow.push(showValues ? text : '');
      }

      matrix.push(row);
      textMatrix.push(textRow);
    }

    // Build trace
    const trace = {
      type: 'heatmap',
      z: matrix,
      x: pageNames,
      y: categories,
      text: textMatrix,
      texttemplate: showValues ? '%{text}' : '',
      textfont: {
        family: 'Inter, system-ui, sans-serif',
        size: 10
      },
      colorscale: colorscale,
      showscale: true,
      colorbar: {
        thickness: 12,
        len: 0.8,
        tickfont: {
          family: 'Inter, system-ui, sans-serif',
          size: 9,
          color: '#6b7280'
        },
        title: {
          text: normalize === 'none' ? 'Count' : '%',
          font: {
            family: 'Oswald, system-ui, sans-serif',
            size: 10,
            color: '#374151'
          }
        }
      },
      hovertemplate: '%{y}<br>%{x}: %{z:.1f}<extra></extra>'
    };

    // Build layout
    const layout = PlotHelpers.createBaseLayout({
      showLegend: false
    });

    layout.xaxis = {
      title: '',
      tickangle: pageNames.length > 4 ? -45 : 0,
      automargin: true,
      tickfont: { size: 10, color: '#374151' }
    };

    layout.yaxis = {
      title: '',
      automargin: true,
      tickfont: { size: 10, color: '#374151' },
      autorange: 'reversed' // Show first category at top
    };

    // Adjust margins for labels
    layout.margin = { l: 100, r: 60, t: 30, b: 60 };

    // Render with Plotly (lazy loaded)
    const config = getPlotlyConfig();

    try {
      const Plotly = await createMinimalPlotly();
      return await Plotly.newPlot(container, [trace], layout, config);
    } catch (err) {
      console.error('[Heatmap] Render error:', err);
      throw new Error(`Failed to render heatmap: ${err.message}`);
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
PlotRegistry.register(heatmapDefinition);

export default heatmapDefinition;
