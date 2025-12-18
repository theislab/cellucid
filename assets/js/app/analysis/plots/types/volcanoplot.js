/**
 * Volcano Plot for Differential Expression Analysis
 *
 * Visualizes differential expression results with:
 * - X-axis: log2 fold change
 * - Y-axis: -log10 p-value (or adjusted p-value)
 * - Color-coded points by significance
 * - Interactive gene labels
 * - Threshold lines
 * Refactored to use BasePlot utilities for consistency.
 */

import { PlotRegistry, BasePlot, COMMON_HOVER_STYLE, createMinimalPlotly, getPlotlyConfig } from '../plot-factory.js';
import { getScatterTraceType } from '../plotly-loader.js';
import { getFiniteMinMax } from '../../shared/number-utils.js';

const volcanoPlotDefinition = {
  id: 'volcanoplot',
  name: 'Volcano Plot',
  description: 'Differential expression visualization showing fold change vs significance',
  supportedDataTypes: ['differential'],
  supportedLayouts: ['single'],

  defaultOptions: {
    pValueThreshold: 0.05,
    foldChangeThreshold: 1.0,
    useAdjustedPValue: true,
    labelTopN: 10,
    pointSize: 6,
    showThresholdLines: true,
    colorScheme: 'default', // 'default', 'red-blue', 'green-purple'
    highlightGenes: [] // Specific genes to always label
  },

  optionSchema: {
    pValueThreshold: {
      type: 'select',
      label: 'p-value threshold',
      options: [
        { value: 0.001, label: '0.001' },
        { value: 0.01, label: '0.01' },
        { value: 0.05, label: '0.05' },
        { value: 0.1, label: '0.1' }
      ]
    },
    foldChangeThreshold: {
      type: 'range',
      label: 'log2 FC threshold',
      min: 0,
      max: 3,
      step: 0.25
    },
    useAdjustedPValue: {
      type: 'checkbox',
      label: 'Use FDR-adjusted p-values'
    },
    labelTopN: {
      type: 'range',
      label: 'Label top genes',
      min: 0,
      max: 50,
      step: 5
    },
    pointSize: {
      type: 'range',
      label: 'Point size',
      min: 3,
      max: 12,
      step: 1
    },
    showThresholdLines: {
      type: 'checkbox',
      label: 'Show threshold lines'
    },
    colorScheme: {
      type: 'select',
      label: 'Color scheme',
      options: [
        { value: 'default', label: 'Blue/Gray/Red' },
        { value: 'warm', label: 'Orange/Gray/Purple' },
        { value: 'nature', label: 'Green/Gray/Magenta' }
      ]
    }
  },

  /**
   * Render volcano plot
   * @param {Object} deResults - Differential expression results from MultiVariableAnalysis
   * @param {Object} options - Plot options
   * @param {HTMLElement} container - Container element
   * @returns {Promise<Object>} Plotly figure reference
   */
  async render(deResults, options, container) {
    const {
      pValueThreshold = 0.05,
      foldChangeThreshold = 1.0,
      useAdjustedPValue = true,
      labelTopN = 10,
      pointSize = 6,
      showThresholdLines = true,
      colorScheme = 'default',
      highlightGenes = []
    } = options;

    // Handle different input formats
    const results = Array.isArray(deResults) ? deResults :
                    deResults.results ? deResults.results : [];

    if (results.length === 0) {
      // Show empty state
      const layout = BasePlot.createLayout({ showLegend: false });
      layout.annotations = [{
        text: 'No differential expression data available',
        x: 0.5,
        y: 0.5,
        xref: 'paper',
        yref: 'paper',
        showarrow: false,
        font: { size: 14, color: '#6b7280' }
      }];
      const Plotly = await createMinimalPlotly();
      return Plotly.newPlot(container, [], layout, getPlotlyConfig());
    }

    // Color schemes
    const colorSchemes = {
      default: { up: '#dc2626', down: '#2563eb', ns: '#9ca3af' },
      warm: { up: '#ea580c', down: '#7c3aed', ns: '#9ca3af' },
      nature: { up: '#16a34a', down: '#db2777', ns: '#9ca3af' }
    };
    const colors = colorSchemes[colorScheme] || colorSchemes.default;

    // Categorize genes
    const upregulated = [];
    const downregulated = [];
    const nonSignificant = [];
    const highlightSet = new Set(highlightGenes.map(g => g.toLowerCase()));

    for (const result of results) {
      if (!result.gene || result.log2FoldChange === undefined) continue;

      const pVal = useAdjustedPValue
        ? (result.adjustedPValue ?? result.pValue)
        : result.pValue;

      if (!Number.isFinite(pVal)) continue;
      if (!Number.isFinite(result.log2FoldChange)) continue;

      const point = {
        gene: result.gene,
        x: result.log2FoldChange,
        y: -Math.log10(Math.max(pVal, 1e-300)), // Prevent -Infinity
        pValue: result.pValue,
        adjustedPValue: result.adjustedPValue,
        meanA: result.meanA,
        meanB: result.meanB
      };

      const isSignificant = pVal < pValueThreshold;
      const hasLargeFoldChange = Math.abs(result.log2FoldChange) >= foldChangeThreshold;

      if (isSignificant && hasLargeFoldChange) {
        if (result.log2FoldChange > 0) {
          upregulated.push(point);
        } else {
          downregulated.push(point);
        }
      } else {
        nonSignificant.push(point);
      }
    }

    // Build traces
    const traces = [];

    // Non-significant points (gray, back layer) - GPU-accelerated
    if (nonSignificant.length > 0) {
      traces.push({
        type: getScatterTraceType(),
        mode: 'markers',
        name: 'Not significant',
        x: nonSignificant.map(p => p.x),
        y: nonSignificant.map(p => p.y),
        text: nonSignificant.map(p => p.gene),
        customdata: nonSignificant.map(p => [p.pValue, p.adjustedPValue, p.meanA, p.meanB]),
        marker: {
          color: colors.ns,
          size: pointSize,
          opacity: 0.4,
          line: { width: 0 }
        },
        hovertemplate: '<b>%{text}</b><br>' +
          'log₂FC: %{x:.2f}<br>' +
          '-log₁₀p: %{y:.2f}<br>' +
          'p-value: %{customdata[0]:.2e}<br>' +
          'adj. p: %{customdata[1]:.2e}<extra></extra>',
        hoverlabel: COMMON_HOVER_STYLE
      });
    }

    // Downregulated points (left side) - GPU-accelerated
    if (downregulated.length > 0) {
      traces.push({
        type: getScatterTraceType(),
        mode: 'markers',
        name: `Down (${downregulated.length})`,
        x: downregulated.map(p => p.x),
        y: downregulated.map(p => p.y),
        text: downregulated.map(p => p.gene),
        customdata: downregulated.map(p => [p.pValue, p.adjustedPValue, p.meanA, p.meanB]),
        marker: {
          color: colors.down,
          size: pointSize,
          opacity: 0.8,
          line: { width: 1, color: '#ffffff' }
        },
        hovertemplate: '<b>%{text}</b><br>' +
          'log₂FC: %{x:.2f}<br>' +
          '-log₁₀p: %{y:.2f}<br>' +
          'p-value: %{customdata[0]:.2e}<br>' +
          'adj. p: %{customdata[1]:.2e}<extra></extra>',
        hoverlabel: COMMON_HOVER_STYLE
      });
    }

    // Upregulated points (right side) - GPU-accelerated
    if (upregulated.length > 0) {
      traces.push({
        type: getScatterTraceType(),
        mode: 'markers',
        name: `Up (${upregulated.length})`,
        x: upregulated.map(p => p.x),
        y: upregulated.map(p => p.y),
        text: upregulated.map(p => p.gene),
        customdata: upregulated.map(p => [p.pValue, p.adjustedPValue, p.meanA, p.meanB]),
        marker: {
          color: colors.up,
          size: pointSize,
          opacity: 0.8,
          line: { width: 1, color: '#ffffff' }
        },
        hovertemplate: '<b>%{text}</b><br>' +
          'log₂FC: %{x:.2f}<br>' +
          '-log₁₀p: %{y:.2f}<br>' +
          'p-value: %{customdata[0]:.2e}<br>' +
          'adj. p: %{customdata[1]:.2e}<extra></extra>',
        hoverlabel: COMMON_HOVER_STYLE
      });
    }

    // Add labels for top genes
    const allSignificant = [...upregulated, ...downregulated];
    allSignificant.sort((a, b) => b.y - a.y); // Sort by -log10 p-value

    // Determine which genes to label
    const genesToLabel = new Set();

    // Always label highlighted genes
    for (const p of allSignificant) {
      if (highlightSet.has(p.gene.toLowerCase())) {
        genesToLabel.add(p.gene);
      }
    }

    // Add top N most significant
    for (let i = 0; i < Math.min(labelTopN, allSignificant.length); i++) {
      genesToLabel.add(allSignificant[i].gene);
    }

    // Create annotations for labels
    const annotations = [];
    for (const p of allSignificant) {
      if (genesToLabel.has(p.gene)) {
        annotations.push({
          x: p.x,
          y: p.y,
          text: p.gene,
          showarrow: true,
          arrowhead: 0,
          arrowsize: 0.5,
          arrowwidth: 1,
          arrowcolor: '#6b7280',
          ax: p.x > 0 ? 30 : -30,
          ay: -20,
          font: {
            family: 'Inter, system-ui, sans-serif',
            size: 10,
            color: '#374151'
          },
          bgcolor: 'rgba(255, 255, 255, 0.8)',
          borderpad: 2
        });
      }
    }

    // Build layout using BasePlot utility
    const layout = BasePlot.createLayout({
      showLegend: true
    });

    // Calculate axis ranges
    const allX = results
      .map(r => r.log2FoldChange)
      .filter(v => typeof v === 'number' && Number.isFinite(v));
    const allY = results
      .map(r => {
        const pRaw = useAdjustedPValue ? (r.adjustedPValue ?? r.pValue) : r.pValue;
        const p = typeof pRaw === 'number' && Number.isFinite(pRaw) ? pRaw : 1;
        return -Math.log10(Math.max(p, 1e-300));
      })
      .filter(v => typeof v === 'number' && Number.isFinite(v));

    const { min: rawMinX, max: rawMaxX } = getFiniteMinMax(allX);
    const minX = Number.isFinite(rawMinX) ? Math.min(rawMinX, 0) : 0;
    const maxX = Number.isFinite(rawMaxX) ? Math.max(rawMaxX, 0) : 0;
    const xMax = Math.max(Math.abs(minX), Math.abs(maxX));

    const { max: rawYMax } = getFiniteMinMax(allY);
    const yMax = Number.isFinite(rawYMax) ? Math.max(rawYMax, 1) : 1;

    layout.xaxis = {
      title: {
        text: 'log₂ Fold Change',
        font: { family: 'Oswald, system-ui, sans-serif', size: 12, color: '#374151' }
      },
      zeroline: true,
      zerolinecolor: '#e5e7eb',
      zerolinewidth: 1,
      range: [-(xMax * 1.1), xMax * 1.1],
      showgrid: true,
      gridcolor: '#f3f4f6',
      tickfont: { size: 10, color: '#6b7280' }
    };

    layout.yaxis = {
      title: {
        text: useAdjustedPValue ? '-log₁₀ (adjusted p-value)' : '-log₁₀ (p-value)',
        font: { family: 'Oswald, system-ui, sans-serif', size: 12, color: '#374151' }
      },
      zeroline: false,
      range: [0, yMax * 1.1],
      showgrid: true,
      gridcolor: '#f3f4f6',
      tickfont: { size: 10, color: '#6b7280' }
    };

    layout.annotations = annotations;

    // Add threshold lines as shapes
    if (showThresholdLines) {
      const pThresholdY = -Math.log10(pValueThreshold);

      layout.shapes = [
        // Horizontal p-value threshold
        {
          type: 'line',
          x0: -(xMax * 1.1),
          x1: xMax * 1.1,
          y0: pThresholdY,
          y1: pThresholdY,
          line: { color: '#9ca3af', width: 1, dash: 'dash' }
        },
        // Vertical fold change thresholds
        {
          type: 'line',
          x0: -foldChangeThreshold,
          x1: -foldChangeThreshold,
          y0: 0,
          y1: yMax * 1.1,
          line: { color: '#9ca3af', width: 1, dash: 'dash' }
        },
        {
          type: 'line',
          x0: foldChangeThreshold,
          x1: foldChangeThreshold,
          y0: 0,
          y1: yMax * 1.1,
          line: { color: '#9ca3af', width: 1, dash: 'dash' }
        }
      ];
    }

    // Legend position
    layout.legend = {
      x: 1,
      y: 1,
      xanchor: 'right',
      yanchor: 'top',
      bgcolor: 'rgba(255, 255, 255, 0.8)',
      bordercolor: '#e5e7eb',
      borderwidth: 1,
      font: { size: 10 }
    };

    layout.margin = { l: 60, r: 20, t: 30, b: 50 };

    // Render with Plotly
    const config = getPlotlyConfig();
    config.scrollZoom = true;

    try {
      const Plotly = await createMinimalPlotly();
      return await Plotly.newPlot(container, traces, layout, config);
    } catch (err) {
      console.error('[VolcanoPlot] Render error:', err);
      throw new Error(`Failed to render volcano plot: ${err.message}`);
    }
  },

  /**
   * Update existing plot using Plotly.react
   * @param {Object} figure - Existing Plotly figure
   * @param {Object} deResults - Differential expression results
   * @param {Object} options - Plot options
   * @returns {Promise<Object>} Updated Plotly figure
   */
  async update(figure, deResults, options) {
    // Volcano plots benefit from full re-render due to annotation complexity
    // But we use Plotly.react for smoother transitions
    try {
      const Plotly = await createMinimalPlotly();

      // Get the traces and layout from a "virtual" render
      const tempContainer = document.createElement('div');
      const tempPlot = await this.render(deResults, options, tempContainer);

      // Extract traces and layout, then apply via react
      const traces = tempPlot.data || [];
      const layout = tempPlot.layout || {};

      return await Plotly.react(figure, traces, layout, getPlotlyConfig());
    } catch (err) {
      console.error('[VolcanoPlot] Update error:', err);
      return this.render(deResults, options, figure);
    }
  },

  /**
   * Export volcano plot data as CSV
   * Exports full differential expression table
   * @param {Object} deResults - Differential expression results
   * @param {Object} options - Plot options
   * @returns {Object} { rows, columns, metadata }
   */
  exportCSV(deResults, options) {
    const {
      pValueThreshold = 0.05,
      foldChangeThreshold = 1.0,
      useAdjustedPValue = true
    } = options;

    const results = Array.isArray(deResults) ? deResults :
                    deResults.results ? deResults.results : [];

    const columns = [
      'gene',
      'log2FoldChange',
      'pValue',
      'adjustedPValue',
      'negLog10P',
      'meanA',
      'meanB',
      'significant',
      'direction'
    ];

    const rows = [];

    for (const result of results) {
      if (!result.gene) continue;

      const rawPValue = typeof result.pValue === 'number' && Number.isFinite(result.pValue)
        ? result.pValue
        : null;
      const adjustedPValue = typeof result.adjustedPValue === 'number' && Number.isFinite(result.adjustedPValue)
        ? result.adjustedPValue
        : null;

      const pVal = useAdjustedPValue
        ? (adjustedPValue ?? rawPValue)
        : rawPValue;

      const log2FoldChange = typeof result.log2FoldChange === 'number' && Number.isFinite(result.log2FoldChange)
        ? result.log2FoldChange
        : null;

      const isSignificant =
        Number.isFinite(pVal) &&
        Number.isFinite(log2FoldChange) &&
        pVal < pValueThreshold &&
        Math.abs(log2FoldChange) >= foldChangeThreshold;

      let direction = 'ns';
      if (isSignificant) {
        direction = log2FoldChange > 0 ? 'up' : 'down';
      }

      rows.push({
        gene: result.gene,
        log2FoldChange: Number.isFinite(log2FoldChange) ? log2FoldChange.toFixed(4) : '',
        pValue: Number.isFinite(rawPValue) ? rawPValue.toExponential(4) : '',
        adjustedPValue: Number.isFinite(adjustedPValue) ? adjustedPValue.toExponential(4) : '',
        negLog10P: Number.isFinite(pVal) ? (-Math.log10(Math.max(pVal, 1e-300))).toFixed(4) : '',
        meanA: typeof result.meanA === 'number' && Number.isFinite(result.meanA) ? result.meanA.toFixed(4) : '',
        meanB: typeof result.meanB === 'number' && Number.isFinite(result.meanB) ? result.meanB.toFixed(4) : '',
        significant: isSignificant ? 'yes' : 'no',
        direction
      });
    }

    // Sort by significance (most significant first)
    rows.sort((a, b) => {
      const pA = parseFloat(useAdjustedPValue ? a.adjustedPValue : a.pValue);
      const pB = parseFloat(useAdjustedPValue ? b.adjustedPValue : b.pValue);
      const aVal = Number.isFinite(pA) ? pA : 1;
      const bVal = Number.isFinite(pB) ? pB : 1;
      return aVal - bVal;
    });

    const summary = this.getSummary(deResults, options);

    return {
      rows,
      columns,
      metadata: {
        plotType: 'volcanoplot',
        totalGenes: results.length,
        upregulated: summary.upregulated,
        downregulated: summary.downregulated,
        notSignificant: summary.notSignificant,
        pValueThreshold,
        foldChangeThreshold,
        useAdjustedPValue,
        exportDate: new Date().toISOString()
      }
    };
  },

  /**
   * Get summary of differential expression results
   */
  getSummary(deResults, options) {
    const {
      pValueThreshold = 0.05,
      foldChangeThreshold = 1.0,
      useAdjustedPValue = true
    } = options;

    const results = Array.isArray(deResults) ? deResults :
                    deResults.results ? deResults.results : [];

    let upregulated = 0;
    let downregulated = 0;
    let notSignificant = 0;

    for (const result of results) {
      const pVal = useAdjustedPValue
        ? (result.adjustedPValue ?? result.pValue)
        : result.pValue;

      if (!Number.isFinite(pVal) || !Number.isFinite(result.log2FoldChange)) {
        notSignificant++;
        continue;
      }

      const isSignificant = pVal < pValueThreshold;
      const hasLargeFoldChange = Math.abs(result.log2FoldChange) >= foldChangeThreshold;

      if (isSignificant && hasLargeFoldChange) {
        if (result.log2FoldChange > 0) {
          upregulated++;
        } else {
          downregulated++;
        }
      } else {
        notSignificant++;
      }
    }

    return {
      total: results.length,
      upregulated,
      downregulated,
      notSignificant,
      significantTotal: upregulated + downregulated
    };
  }
};

// Register the plot type
PlotRegistry.register(volcanoPlotDefinition);

export default volcanoPlotDefinition;
