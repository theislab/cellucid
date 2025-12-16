/**
 * Pie/Donut Chart Plot Type
 *
 * Shows proportions within a single page or side-by-side for multiple pages.
 * Supports donut variant for better readability.
 */

import { PlotRegistry, PlotHelpers } from '../plot-registry.js';
import { getPlotlyConfig, createMinimalPlotly } from '../plotly-loader.js';

const pieplot = {
  id: 'pieplot',
  name: 'Pie / Donut',
  description: 'Proportions within pages',
  supportedDataTypes: ['categorical'],
  supportedLayouts: ['side-by-side', 'grid'],

  optionSchema: {
    donut: {
      type: 'checkbox',
      label: 'Donut style',
      default: true
    },
    showPercent: {
      type: 'checkbox',
      label: 'Show percentages',
      default: true
    },
    showLabels: {
      type: 'checkbox',
      label: 'Show category labels',
      default: true
    },
    maxCategories: {
      type: 'range',
      label: 'Max categories',
      min: 3,
      max: 20,
      step: 1,
      default: 10
    },
    sortByValue: {
      type: 'checkbox',
      label: 'Sort by value',
      default: true
    }
  },

  defaultOptions: {
    donut: true,
    showPercent: true,
    showLabels: true,
    maxCategories: 10,
    sortByValue: true
  },

  /**
   * Render pie/donut chart
   * @param {Object[]} pageData - Data for each page
   * @param {Object} options - Plot options
   * @param {HTMLElement} container - Container element
   * @param {Object} layoutEngine - Layout engine instance
   */
  async render(pageData, options, container, layoutEngine) {
    const Plotly = await createMinimalPlotly();

    const numPages = pageData.length;
    const cols = Math.min(numPages, 3);
    const rows = Math.ceil(numPages / cols);

    // Build traces - one pie per page
    const traces = [];
    const annotations = [];

    pageData.forEach((pd, index) => {
      // Count categories
      const counts = new Map();
      for (const val of pd.values) {
        counts.set(val, (counts.get(val) || 0) + 1);
      }

      // Sort and limit categories
      let entries = Array.from(counts.entries());
      if (options.sortByValue) {
        entries.sort((a, b) => b[1] - a[1]);
      }

      if (entries.length > options.maxCategories) {
        const topEntries = entries.slice(0, options.maxCategories - 1);
        const otherSum = entries.slice(options.maxCategories - 1).reduce((s, e) => s + e[1], 0);
        entries = [...topEntries, ['Other', otherSum]];
      }

      const labels = entries.map(e => e[0]);
      const values = entries.map(e => e[1]);

      // Calculate subplot domain
      const col = index % cols;
      const row = Math.floor(index / cols);

      const xGap = 0.05;
      const yGap = 0.08;
      const xSize = (1 - xGap * (cols - 1)) / cols;
      const ySize = (1 - yGap * (rows - 1)) / rows;

      const xStart = col * (xSize + xGap);
      const yStart = 1 - (row + 1) * (ySize + yGap) + yGap;

      traces.push({
        type: 'pie',
        labels: labels,
        values: values,
        name: pd.pageName,
        hole: options.donut ? 0.4 : 0,
        domain: {
          x: [xStart, xStart + xSize],
          y: [yStart, yStart + ySize]
        },
        textinfo: options.showPercent && options.showLabels ? 'label+percent'
          : options.showPercent ? 'percent'
          : options.showLabels ? 'label'
          : 'none',
        textposition: 'inside',
        insidetextorientation: 'radial',
        textfont: {
          family: 'Inter, system-ui, sans-serif',
          size: 10,
          color: '#ffffff'
        },
        marker: {
          line: {
            color: '#ffffff',
            width: 1
          }
        },
        hovertemplate: '%{label}: %{value} (%{percent})<extra>' + pd.pageName + '</extra>',
        showlegend: index === 0 // Only show legend for first pie
      });

      // Add page name annotation
      annotations.push({
        text: `<b>${pd.pageName}</b>`,
        x: xStart + xSize / 2,
        y: yStart + ySize + 0.02,
        xref: 'paper',
        yref: 'paper',
        showarrow: false,
        font: {
          family: 'Oswald, system-ui, sans-serif',
          size: 11,
          color: '#111827'
        }
      });
    });

    // Layout - use PlotHelpers for consistency with other plot types
    const layout = PlotHelpers.createBaseLayout({
      showLegend: true
    });

    layout.legend = {
      orientation: 'h',
      x: 0.5,
      xanchor: 'center',
      y: -0.05,
      font: {
        family: 'Inter, system-ui, sans-serif',
        size: 10,
        color: '#374151'
      }
    };

    layout.annotations = annotations;
    layout.margin = { l: 20, r: 20, t: 40, b: 40 };
    layout.height = rows * 200 + 60;

    // Render
    await Plotly.newPlot(container, traces, layout, getPlotlyConfig());

    return { traces, layout };
  }
};

PlotRegistry.register(pieplot);
export default pieplot;
