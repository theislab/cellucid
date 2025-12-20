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
import { getFiniteMinMax, isFiniteNumber } from '../../shared/number-utils.js';

/**
 * Precomputed, columnar volcano-plot data for a single DE result set.
 *
 * We intentionally store small TypedArrays (not per-point objects) so updates
 * can reuse buffers and avoid repeated allocation spikes on slider changes.
 *
 * @typedef {Object} VolcanoPrecomputed
 * @property {string[]} genes
 * @property {Float32Array} log2FoldChange
 * @property {Float64Array} pValue
 * @property {Float64Array} adjustedPValue
 * @property {Float64Array} pAdjustedOrRaw
 * @property {Float32Array} negLog10PRaw
 * @property {Float32Array} negLog10PAdjustedOrRaw
 */

/** @type {WeakMap<Object[], VolcanoPrecomputed>} */
const VOLCANO_CACHE = new WeakMap();

/**
 * Normalize DE results input to a flat array.
 * @param {Object|Object[]} deResults
 * @returns {Object[]}
 */
function normalizeDEResults(deResults) {
  if (Array.isArray(deResults)) return deResults;
  if (Array.isArray(deResults?.results)) return deResults.results;
  return [];
}

/**
 * Build (or reuse) columnar arrays for volcano plotting.
 * @param {Object[]} results
 * @returns {VolcanoPrecomputed}
 */
function getVolcanoPrecomputed(results) {
  const cached = VOLCANO_CACHE.get(results);
  if (cached) return cached;

  const n = results.length;
  const genes = new Array(n);
  const log2FoldChange = new Float32Array(n);
  const pValue = new Float64Array(n);
  const adjustedPValue = new Float64Array(n);
  const pAdjustedOrRaw = new Float64Array(n);
  const negLog10PRaw = new Float32Array(n);
  const negLog10PAdjustedOrRaw = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const row = results[i] || {};
    genes[i] = String(row.gene ?? '');

    const fc = isFiniteNumber(row.log2FoldChange) ? row.log2FoldChange : NaN;
    log2FoldChange[i] = fc;

    const pRaw = isFiniteNumber(row.pValue) ? row.pValue : NaN;
    const pAdj = isFiniteNumber(row.adjustedPValue) ? row.adjustedPValue : NaN;
    pValue[i] = pRaw;
    adjustedPValue[i] = pAdj;

    const pAdjOrRaw = isFiniteNumber(pAdj) ? pAdj : pRaw;
    pAdjustedOrRaw[i] = pAdjOrRaw;

    const rawForLog = isFiniteNumber(pRaw) ? Math.max(pRaw, 1e-300) : NaN;
    const adjForLog = isFiniteNumber(pAdjOrRaw) ? Math.max(pAdjOrRaw, 1e-300) : NaN;
    negLog10PRaw[i] = isFiniteNumber(rawForLog) ? -Math.log10(rawForLog) : NaN;
    negLog10PAdjustedOrRaw[i] = isFiniteNumber(adjForLog) ? -Math.log10(adjForLog) : NaN;
  }

  const precomputed = {
    genes,
    log2FoldChange,
    pValue,
    adjustedPValue,
    pAdjustedOrRaw,
    negLog10PRaw,
    negLog10PAdjustedOrRaw
  };

  VOLCANO_CACHE.set(results, precomputed);
  return precomputed;
}

function getVolcanoColors(colorScheme) {
  const colorSchemes = {
    default: { up: '#dc2626', down: '#2563eb', ns: '#9ca3af' },
    warm: { up: '#ea580c', down: '#7c3aed', ns: '#9ca3af' },
    nature: { up: '#16a34a', down: '#db2777', ns: '#9ca3af' }
  };
  return colorSchemes[colorScheme] || colorSchemes.default;
}

/**
 * Compute per-point category codes for coloring and legend counts.
 *
 * Codes:
 * - 0: not significant
 * - 1: downregulated significant
 * - 2: upregulated significant
 *
 * @param {VolcanoPrecomputed} pre
 * @param {Object} options
 * @returns {{ codes: Uint8Array, up: number, down: number, ns: number }}
 */
function computeVolcanoCategoryCodes(pre, options) {
  const {
    pValueThreshold = 0.05,
    foldChangeThreshold = 1.0,
    useAdjustedPValue = true
  } = options || {};

  const pVals = useAdjustedPValue ? pre.pAdjustedOrRaw : pre.pValue;
  const n = pre.log2FoldChange.length;
  const codes = new Uint8Array(n);

  let up = 0;
  let down = 0;
  let ns = 0;

  for (let i = 0; i < n; i++) {
    const p = pVals[i];
    const fc = pre.log2FoldChange[i];

    const significant = isFiniteNumber(p) &&
      isFiniteNumber(fc) &&
      p < pValueThreshold &&
      Math.abs(fc) >= foldChangeThreshold;

    if (!significant) {
      codes[i] = 0;
      ns++;
      continue;
    }

    if (fc > 0) {
      codes[i] = 2;
      up++;
    } else {
      codes[i] = 1;
      down++;
    }
  }

  return { codes, up, down, ns };
}

/**
 * Build label annotations for significant genes.
 * @param {VolcanoPrecomputed} pre
 * @param {Uint8Array} codes
 * @param {Float32Array} yValues
 * @param {Object} options
 * @returns {Object[]}
 */
function buildVolcanoAnnotations(pre, codes, yValues, options) {
  const { labelTopN = 10, highlightGenes = [] } = options || {};
  const highlightSet = new Set((highlightGenes || []).map(g => String(g).toLowerCase()));
  const wantTop = Number.isFinite(labelTopN) ? Math.max(0, Math.floor(labelTopN)) : 0;

  /** @type {Set<number>} */
  const labelIndices = new Set();

  // Always label explicitly highlighted genes (when significant).
  if (highlightSet.size > 0) {
    for (let i = 0; i < codes.length; i++) {
      if (codes[i] === 0) continue;
      const gene = pre.genes[i];
      if (gene && highlightSet.has(gene.toLowerCase())) {
        labelIndices.add(i);
      }
    }
  }

  // Add top-N significant genes by y (most significant).
  if (wantTop > 0) {
    /** @type {number[]} */
    const top = [];

    const scoreAt = (idx) => yValues[idx];
    const sortAsc = () => top.sort((a, b) => scoreAt(a) - scoreAt(b));

    for (let i = 0; i < codes.length; i++) {
      if (codes[i] === 0) continue;
      const y = yValues[i];
      if (!isFiniteNumber(y)) continue;

      if (top.length < wantTop) {
        top.push(i);
        if (top.length === wantTop) sortAsc();
        continue;
      }

      if (y <= scoreAt(top[0])) continue;
      top[0] = i;
      sortAsc();
    }

    for (const idx of top) labelIndices.add(idx);
  }

  const annotations = [];
  for (const idx of labelIndices) {
    const x = pre.log2FoldChange[idx];
    const y = yValues[idx];
    const gene = pre.genes[idx];
    if (!gene || !isFiniteNumber(x) || !isFiniteNumber(y)) continue;

    annotations.push({
      x,
      y,
      text: gene,
      showarrow: true,
      arrowhead: 0,
      arrowsize: 0.5,
      arrowwidth: 1,
      arrowcolor: '#6b7280',
      ax: x > 0 ? 30 : -30,
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

  return annotations;
}

/**
 * Build traces/layout/config for a volcano plot without touching the DOM.
 * This avoids creating throwaway Plotly figures during updates (which can leak WebGL memory).
 *
 * @param {Object|Object[]} deResults
 * @param {Object} options
 * @returns {{traces: Object[], layout: Object, config: Object}}
 */
function buildVolcanoFigure(deResults, options) {
  const {
    pValueThreshold = 0.05,
    foldChangeThreshold = 1.0,
    useAdjustedPValue = true,
    pointSize = 6,
    showThresholdLines = true,
    colorScheme = 'default',
    highlightGenes = [],
    labelTopN = 10
  } = options || {};

  // Handle different input formats
  const results = normalizeDEResults(deResults);

  // Base config
  const config = getPlotlyConfig();
  config.scrollZoom = true;

  if (results.length === 0) {
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
    return { traces: [], layout, config };
  }

  const colors = getVolcanoColors(colorScheme);
  const pre = getVolcanoPrecomputed(results);
  const yValues = useAdjustedPValue ? pre.negLog10PAdjustedOrRaw : pre.negLog10PRaw;
  const { codes, up, down, ns } = computeVolcanoCategoryCodes(pre, {
    pValueThreshold,
    foldChangeThreshold,
    useAdjustedPValue
  });

  // Build traces
  const traces = [];

  // Main trace: all genes in a single WebGL trace; threshold changes only update marker encoding.
  traces.push({
    type: getScatterTraceType(),
    mode: 'markers',
    name: 'Genes',
    x: pre.log2FoldChange,
    y: yValues,
    text: pre.genes,
    meta: { cellucid: 'volcano', version: 2 },
    marker: {
      // Encode categories as numeric codes to avoid allocating large color-string arrays.
      color: codes,
      cmin: 0,
      cmax: 2,
      colorscale: [
        [0.0, colors.ns],
        [0.5, colors.down],
        [1.0, colors.up]
      ],
      showscale: false,
      size: pointSize,
      opacity: 0.85,
      line: { width: 0 }
    },
    hovertemplate: '<b>%{text}</b><br>' +
      'log₂FC: %{x:.2f}<br>' +
      '-log₁₀p: %{y:.2f}<extra></extra>',
    hoverlabel: COMMON_HOVER_STYLE,
    showlegend: false
  });

  // Legend-only traces so users can read the category colors without splitting the main trace.
  const legendMarkerSize = pointSize;
  traces.push({
    type: getScatterTraceType(),
    mode: 'markers',
    name: `Up (${up})`,
    x: [0],
    y: [0],
    marker: { color: colors.up, size: legendMarkerSize, opacity: 0.85, line: { width: 0 } },
    visible: 'legendonly',
    hoverinfo: 'skip'
  });
  traces.push({
    type: getScatterTraceType(),
    mode: 'markers',
    name: `Down (${down})`,
    x: [0],
    y: [0],
    marker: { color: colors.down, size: legendMarkerSize, opacity: 0.85, line: { width: 0 } },
    visible: 'legendonly',
    hoverinfo: 'skip'
  });
  traces.push({
    type: getScatterTraceType(),
    mode: 'markers',
    name: `Not significant (${ns})`,
    x: [0],
    y: [0],
    marker: { color: colors.ns, size: legendMarkerSize, opacity: 0.85, line: { width: 0 } },
    visible: 'legendonly',
    hoverinfo: 'skip'
  });

  // Build layout using BasePlot utility
  const layout = BasePlot.createLayout({
    showLegend: true
  });

  // Calculate axis ranges
  const { min: rawMinX, max: rawMaxX } = getFiniteMinMax(pre.log2FoldChange);
  const minX = Number.isFinite(rawMinX) ? Math.min(rawMinX, 0) : 0;
  const maxX = Number.isFinite(rawMaxX) ? Math.max(rawMaxX, 0) : 0;
  const xMax = Math.max(Math.abs(minX), Math.abs(maxX));

  const { max: rawYMax } = getFiniteMinMax(yValues);
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

  layout.annotations = buildVolcanoAnnotations(pre, codes, yValues, { labelTopN, highlightGenes });

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

  return { traces, layout, config };
}

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
    try {
      const Plotly = await createMinimalPlotly();
      const figure = buildVolcanoFigure(deResults, options);
      return await Plotly.newPlot(container, figure.traces, figure.layout, figure.config);
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
    try {
      const Plotly = await createMinimalPlotly();
      const nextFigure = buildVolcanoFigure(deResults, options);

      const hasExpectedTrace = !!(
        figure?.data?.[0]?.meta?.cellucid === 'volcano' &&
        figure?.data?.[0]?.meta?.version === 2
      );

      if (!hasExpectedTrace || typeof Plotly.restyle !== 'function' || typeof Plotly.relayout !== 'function') {
        return await Plotly.react(figure, nextFigure.traces, nextFigure.layout, nextFigure.config);
      }

      // Update main trace in-place (avoid full react churn on WebGL plots).
      await Plotly.restyle(figure, {
        y: [nextFigure.traces[0].y],
        'marker.size': [nextFigure.traces[0].marker.size],
        'marker.color': [nextFigure.traces[0].marker.color],
        'marker.colorscale': [nextFigure.traces[0].marker.colorscale]
      }, [0]);

      // Update legend-only trace names (counts).
      await Plotly.restyle(figure, { name: [nextFigure.traces[1].name] }, [1]);
      await Plotly.restyle(figure, { name: [nextFigure.traces[2].name] }, [2]);
      await Plotly.restyle(figure, { name: [nextFigure.traces[3].name] }, [3]);

      await Plotly.relayout(figure, {
        'xaxis.title.text': nextFigure.layout.xaxis?.title?.text,
        'yaxis.title.text': nextFigure.layout.yaxis?.title?.text,
        'xaxis.range': nextFigure.layout.xaxis?.range,
        'yaxis.range': nextFigure.layout.yaxis?.range,
        annotations: nextFigure.layout.annotations,
        shapes: nextFigure.layout.shapes || []
      });

      return figure;
    } catch (err) {
      console.error('[VolcanoPlot] Update error:', err);
      try {
        const Plotly = await createMinimalPlotly();
        Plotly.purge?.(figure);
      } catch (_purgeErr) {
        // Ignore purge failures
      }
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

      const rawPValue = isFiniteNumber(result.pValue)
        ? result.pValue
        : null;
      const adjustedPValue = isFiniteNumber(result.adjustedPValue)
        ? result.adjustedPValue
        : null;

      const pVal = useAdjustedPValue
        ? (adjustedPValue ?? rawPValue)
        : rawPValue;

      const log2FoldChange = isFiniteNumber(result.log2FoldChange)
        ? result.log2FoldChange
        : null;

      const isSignificant =
        isFiniteNumber(pVal) &&
        isFiniteNumber(log2FoldChange) &&
        pVal < pValueThreshold &&
        Math.abs(log2FoldChange) >= foldChangeThreshold;

      let direction = 'ns';
      if (isSignificant) {
        direction = log2FoldChange > 0 ? 'up' : 'down';
      }

      rows.push({
        gene: result.gene,
        log2FoldChange: isFiniteNumber(log2FoldChange) ? log2FoldChange.toFixed(4) : '',
        pValue: isFiniteNumber(rawPValue) ? rawPValue.toExponential(4) : '',
        adjustedPValue: isFiniteNumber(adjustedPValue) ? adjustedPValue.toExponential(4) : '',
        negLog10P: isFiniteNumber(pVal) ? (-Math.log10(Math.max(pVal, 1e-300))).toFixed(4) : '',
        meanA: isFiniteNumber(result.meanA) ? result.meanA.toFixed(4) : '',
        meanB: isFiniteNumber(result.meanB) ? result.meanB.toFixed(4) : '',
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

      if (!isFiniteNumber(pVal) || !isFiniteNumber(result.log2FoldChange)) {
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
