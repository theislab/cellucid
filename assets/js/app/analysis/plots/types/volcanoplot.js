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
import { PLOTLY_2D_SCATTER_TRACE_TYPE } from '../plotly-loader.js';
import { getFiniteMinMax, isFiniteNumber } from '../../shared/number-utils.js';
import { applyLegendPosition } from '../../shared/legend-utils.js';
import { getPlotTheme } from '../../shared/plot-theme.js';
import { escapeHtml } from '../../../utils/dom-utils.js';

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
 * @property {Float64Array} negLog10PRaw
 * @property {Float64Array} negLog10PAdjusted
 */

/** @type {WeakMap<Object[], VolcanoPrecomputed>} */
const VOLCANO_CACHE = new WeakMap();

const VOLCANO_LABEL_FONT_SIZE = 10;
const VOLCANO_LABEL_CHARACTER_WIDTH = 6;
const VOLCANO_LABEL_HORIZONTAL_PADDING = 10;
const VOLCANO_LABEL_ROW_HEIGHT = 20;
const VOLCANO_LABEL_STATUS_HEIGHT = 24;
const VOLCANO_LABEL_TOP_PADDING = 8;
const VOLCANO_LABEL_HORIZONTAL_GAP = 6;
const VOLCANO_MIN_PLOT_HEIGHT = 120;
const VOLCANO_MARGIN_LEFT = 60;
const VOLCANO_MARGIN_RIGHT = 20;
const VOLCANO_MARGIN_BOTTOM = 90;

/**
 * Read the sole current differential-expression result contract.
 * @param {{results: Object[]}} deResults
 * @returns {Object[]}
 */
function requireDEResults(deResults) {
  if (
    deResults === null ||
    typeof deResults !== 'object' ||
    Array.isArray(deResults) ||
    !Array.isArray(deResults.results)
  ) {
    throw new TypeError(
      'Volcano plot data must be an object with a results array'
    );
  }
  return deResults.results;
}

/**
 * Require real rendered dimensions so label capacity is based on actual space.
 * @param {HTMLElement} container
 * @returns {{width: number, height: number}}
 */
function requireVolcanoViewport(container) {
  const width = container?.clientWidth;
  const height = container?.clientHeight;
  if (!isFiniteNumber(width) || width <= 0) {
    throw new RangeError('Volcano plot container clientWidth must be positive');
  }
  if (!isFiniteNumber(height) || height <= 0) {
    throw new RangeError('Volcano plot container clientHeight must be positive');
  }
  return { width, height };
}

/**
 * Read an optional result that is already a finite number.
 * NaN/null/undefined are the explicit unavailable representations.
 * @param {*} value
 * @param {string} field
 * @param {string} gene
 * @returns {number}
 */
function readOptionalFiniteNumber(value, field, gene) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return NaN;
  }
  if (!isFiniteNumber(value)) {
    throw new TypeError(`${field} for ${gene} must be a finite number or unavailable`);
  }
  return value;
}

/**
 * Read an optional probability without flooring or substitution.
 * @param {*} value
 * @param {string} field
 * @param {string} gene
 * @returns {number}
 */
function readProbability(value, field, gene) {
  const probability = readOptionalFiniteNumber(value, field, gene);
  if (Number.isNaN(probability)) return NaN;
  if (probability < 0 || probability > 1) {
    throw new RangeError(`${field} for ${gene} must be between 0 and 1`);
  }
  return probability;
}

/**
 * Compute exact mathematical significance.
 * @param {number} probability
 * @returns {number}
 */
function negativeLog10Probability(probability) {
  if (Number.isNaN(probability)) return NaN;
  if (probability === 0) return Number.POSITIVE_INFINITY;
  return -Math.log10(probability);
}

/**
 * Validate the current volcano option contract.
 * @param {Object} options
 * @returns {Object}
 */
function requireVolcanoOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Volcano plot options must be an object');
  }
  if (
    !isFiniteNumber(options.pValueThreshold) ||
    options.pValueThreshold <= 0 ||
    options.pValueThreshold > 1
  ) {
    throw new RangeError('Volcano pValueThreshold must be greater than 0 and at most 1');
  }
  if (
    !isFiniteNumber(options.foldChangeThreshold) ||
    options.foldChangeThreshold < 0
  ) {
    throw new RangeError('Volcano foldChangeThreshold must be non-negative');
  }
  if (typeof options.useAdjustedPValue !== 'boolean') {
    throw new TypeError('Volcano useAdjustedPValue must be boolean');
  }
  if (!Number.isInteger(options.labelTopN) || options.labelTopN < 0 || options.labelTopN > 50) {
    throw new RangeError('Volcano labelTopN must be an integer between 0 and 50');
  }
  if (!isFiniteNumber(options.pointSize) || options.pointSize <= 0) {
    throw new RangeError('Volcano pointSize must be positive');
  }
  if (typeof options.showThresholdLines !== 'boolean') {
    throw new TypeError('Volcano showThresholdLines must be boolean');
  }
  if (!Array.isArray(options.highlightGenes) ||
      options.highlightGenes.some(gene => typeof gene !== 'string' || gene.length === 0)) {
    throw new TypeError('Volcano highlightGenes must be an array of non-empty strings');
  }
  return options;
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
  const negLog10PRaw = new Float64Array(n);
  const negLog10PAdjusted = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const row = results[i];
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new TypeError(`Volcano result at index ${i} must be an object`);
    }
    if (typeof row.gene !== 'string' || row.gene.length === 0) {
      throw new TypeError(`Volcano result at index ${i} must have a non-empty gene`);
    }
    genes[i] = row.gene;

    const fc = readOptionalFiniteNumber(row.log2FoldChange, 'log2FoldChange', row.gene);
    log2FoldChange[i] = fc;

    const pRaw = readProbability(row.pValue, 'pValue', row.gene);
    const pAdj = readProbability(row.adjustedPValue, 'adjustedPValue', row.gene);
    pValue[i] = pRaw;
    adjustedPValue[i] = pAdj;
    negLog10PRaw[i] = negativeLog10Probability(pRaw);
    negLog10PAdjusted[i] = negativeLog10Probability(pAdj);
  }

  const precomputed = {
    genes,
    log2FoldChange,
    pValue,
    adjustedPValue,
    negLog10PRaw,
    negLog10PAdjusted
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
  const colors = colorSchemes[colorScheme];
  if (!colors) {
    throw new RangeError(`Unsupported volcano color scheme: ${colorScheme}`);
  }
  return colors;
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
  const { pValueThreshold, foldChangeThreshold, useAdjustedPValue } = options;

  const pVals = useAdjustedPValue ? pre.adjustedPValue : pre.pValue;
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
 * Build deterministic label annotations for significant genes.
 * @param {VolcanoPrecomputed} pre
 * @param {Uint8Array} codes
 * @param {Float64Array} mathematicalYValues
 * @param {Float64Array} displayYValues
 * @param {Object} options
 * @param {{width: number, height: number}} viewport
 * @param {[number, number]} xRange
 * @param {[number, number]} yRange
 * @returns {{
 *   annotations: Object[],
 *   marginTop: number,
 *   requested: number,
 *   displayed: number
 * }}
 */
function buildVolcanoAnnotations(
  pre,
  codes,
  mathematicalYValues,
  displayYValues,
  options,
  viewport,
  xRange,
  yRange
) {
  const { labelTopN, highlightGenes } = options;
  const theme = getPlotTheme();
  const highlightSet = new Set(highlightGenes);

  /** @type {number[]} */
  const significantIndices = [];
  for (let i = 0; i < codes.length; i++) {
    const score = mathematicalYValues[i];
    if (
      codes[i] !== 0 &&
      isFiniteNumber(pre.log2FoldChange[i]) &&
      (isFiniteNumber(score) || score === Number.POSITIVE_INFINITY)
    ) {
      significantIndices.push(i);
    }
  }

  significantIndices.sort((a, b) => {
    const scoreA = mathematicalYValues[a];
    const scoreB = mathematicalYValues[b];
    if (scoreA === Number.POSITIVE_INFINITY && scoreB !== Number.POSITIVE_INFINITY) return -1;
    if (scoreB === Number.POSITIVE_INFINITY && scoreA !== Number.POSITIVE_INFINITY) return 1;
    if (scoreA !== scoreB) return scoreB - scoreA;

    const foldA = Math.abs(pre.log2FoldChange[a]);
    const foldB = Math.abs(pre.log2FoldChange[b]);
    if (foldA !== foldB) return foldB - foldA;

    const geneA = pre.genes[a];
    const geneB = pre.genes[b];
    if (geneA < geneB) return -1;
    if (geneA > geneB) return 1;
    return a - b;
  });

  const highlightedIndices = significantIndices.filter(
    index => highlightSet.has(pre.genes[index])
  );
  if (highlightedIndices.length > labelTopN) {
    throw new RangeError(
      `Volcano labelTopN ${labelTopN} cannot display ${highlightedIndices.length} highlighted genes`
    );
  }

  const selectedIndices = [...highlightedIndices];
  const selectedSet = new Set(selectedIndices);
  for (const index of significantIndices) {
    if (selectedIndices.length >= labelTopN) break;
    if (!selectedSet.has(index)) {
      selectedIndices.push(index);
      selectedSet.add(index);
    }
  }

  const plotWidth = viewport.width - VOLCANO_MARGIN_LEFT - VOLCANO_MARGIN_RIGHT;
  if (plotWidth <= 0) {
    throw new RangeError('Volcano plot width is too small for its axes');
  }

  const availableLabelHeight = viewport.height -
    VOLCANO_MARGIN_BOTTOM -
    VOLCANO_MIN_PLOT_HEIGHT -
    VOLCANO_LABEL_STATUS_HEIGHT -
    VOLCANO_LABEL_TOP_PADDING;
  const maxRows = Math.max(
    1,
    Math.floor(availableLabelHeight / VOLCANO_LABEL_ROW_HEIGHT)
  );
  const xSpan = xRange[1] - xRange[0];

  /** @type {Array<Array<{left: number, right: number}>>} */
  const rowIntervals = Array.from({ length: maxRows }, () => []);
  /** @type {Array<{index: number, row: number, centerX: number}>} */
  const placements = [];

  for (const index of selectedIndices) {
    const x = pre.log2FoldChange[index];
    const gene = pre.genes[index];
    const pointX = VOLCANO_MARGIN_LEFT +
      ((x - xRange[0]) / xSpan) * plotWidth;
    const estimatedWidth = (
      gene.length * VOLCANO_LABEL_CHARACTER_WIDTH
    ) + VOLCANO_LABEL_HORIZONTAL_PADDING;
    const halfWidth = estimatedWidth / 2;
    const centerX = Math.min(
      viewport.width - VOLCANO_MARGIN_RIGHT - halfWidth,
      Math.max(VOLCANO_MARGIN_LEFT + halfWidth, pointX)
    );
    const interval = {
      left: centerX - halfWidth,
      right: centerX + halfWidth
    };

    let selectedRow = -1;
    for (let row = 0; row < rowIntervals.length; row++) {
      const collides = rowIntervals[row].some(existing =>
        interval.left < existing.right + VOLCANO_LABEL_HORIZONTAL_GAP &&
        interval.right > existing.left - VOLCANO_LABEL_HORIZONTAL_GAP
      );
      if (!collides) {
        selectedRow = row;
        break;
      }
    }

    if (selectedRow === -1) continue;
    rowIntervals[selectedRow].push(interval);
    placements.push({ index, row: selectedRow, centerX });
  }

  const rowCount = placements.length === 0
    ? 0
    : Math.max(...placements.map(placement => placement.row)) + 1;
  const marginTop = VOLCANO_LABEL_STATUS_HEIGHT +
    (rowCount * VOLCANO_LABEL_ROW_HEIGHT) +
    VOLCANO_LABEL_TOP_PADDING;
  const plotHeight = viewport.height - marginTop - VOLCANO_MARGIN_BOTTOM;

  const annotations = placements.map(({ index, row, centerX }) => {
    const x = pre.log2FoldChange[index];
    const y = displayYValues[index];
    const pointX = VOLCANO_MARGIN_LEFT +
      ((x - xRange[0]) / xSpan) * plotWidth;
    const pointY = marginTop +
      (1 - ((y - yRange[0]) / (yRange[1] - yRange[0]))) * plotHeight;
    const labelY = VOLCANO_LABEL_STATUS_HEIGHT +
      (row * VOLCANO_LABEL_ROW_HEIGHT) +
      (VOLCANO_LABEL_ROW_HEIGHT / 2);

    return {
      x,
      y,
      xref: 'x',
      yref: 'y',
      text: escapeHtml(pre.genes[index]),
      showarrow: true,
      arrowhead: 0,
      arrowsize: 0.5,
      arrowwidth: 1,
      arrowcolor: theme.textMuted,
      ax: centerX - pointX,
      ay: labelY - pointY,
      font: {
        family: theme.fontFamily,
        size: VOLCANO_LABEL_FONT_SIZE,
        color: theme.text
      },
      bgcolor: theme.legend.bg,
      bordercolor: theme.legend.border,
      borderwidth: 1,
      borderpad: 2
    };
  });

  annotations.push({
    x: 0,
    y: 1,
    xref: 'paper',
    yref: 'paper',
    xanchor: 'left',
    yanchor: 'middle',
    yshift: marginTop - (VOLCANO_LABEL_STATUS_HEIGHT / 2),
    text: `${placements.length} of ${labelTopN} gene labels shown`,
    showarrow: false,
    font: {
      family: theme.fontFamily,
      size: 10,
      color: placements.length === labelTopN ? theme.textMuted : theme.text
    }
  });

  return {
    annotations,
    marginTop,
    requested: labelTopN,
    displayed: placements.length
  };
}

/**
 * Build traces/layout/config for a volcano plot without touching the DOM.
 * This avoids creating throwaway Plotly figures during updates (which can leak WebGL memory).
 *
 * @param {{results: Object[]}} deResults
 * @param {Object} options
 * @param {{width: number, height: number}} viewport
 * @returns {{traces: Object[], layout: Object, config: Object}}
 */
function buildVolcanoFigure(deResults, options, viewport) {
  requireVolcanoOptions(options);
  const {
    pValueThreshold,
    foldChangeThreshold,
    useAdjustedPValue,
    pointSize,
    showThresholdLines,
    colorScheme,
    highlightGenes,
    labelTopN
  } = options;

  const results = requireDEResults(deResults);

  const theme = getPlotTheme();

  // Base config
  const config = getPlotlyConfig();
  config.scrollZoom = true;

  if (results.length === 0) {
    const layout = BasePlot.createLayout({ showLegend: false });
    layout.margin = {
      l: VOLCANO_MARGIN_LEFT,
      r: VOLCANO_MARGIN_RIGHT,
      t: 30,
      b: VOLCANO_MARGIN_BOTTOM
    };
    layout.annotations = [{
      text: 'No differential expression data available',
      x: 0.5,
      y: 0.5,
      xref: 'paper',
      yref: 'paper',
      showarrow: false,
      font: { size: 14, color: theme.textMuted }
    }];
    return { traces: [], layout, config };
  }

  const colors = getVolcanoColors(colorScheme);
  const pre = getVolcanoPrecomputed(results);
  const genesNeedEscaping = pre.genes.some((gene) => /[&<>"']/.test(gene));
  const safeGenes = genesNeedEscaping ? pre.genes.map((gene) => escapeHtml(gene)) : pre.genes;
  const selectedPValues = useAdjustedPValue ? pre.adjustedPValue : pre.pValue;
  const mathematicalYValues = useAdjustedPValue
    ? pre.negLog10PAdjusted
    : pre.negLog10PRaw;
  const { codes, up, down, ns } = computeVolcanoCategoryCodes(pre, {
    pValueThreshold,
    foldChangeThreshold,
    useAdjustedPValue
  });

  const displayYValues = new Float64Array(mathematicalYValues.length);
  /** @type {number[]} */
  const zeroProbabilityIndices = [];
  for (let i = 0; i < mathematicalYValues.length; i++) {
    const mathematicalY = mathematicalYValues[i];
    if (mathematicalY === Number.POSITIVE_INFINITY) {
      displayYValues[i] = NaN;
      zeroProbabilityIndices.push(i);
    } else {
      displayYValues[i] = mathematicalY;
    }
  }

  // Calculate exact data domains before assigning the explicit p=0 display boundary.
  const { min: rawMinX, max: rawMaxX } = getFiniteMinMax(pre.log2FoldChange);
  const minX = Number.isFinite(rawMinX) ? Math.min(rawMinX, 0) : 0;
  const maxX = Number.isFinite(rawMaxX) ? Math.max(rawMaxX, 0) : 0;
  const xMax = Math.max(Math.abs(minX), Math.abs(maxX), Number.EPSILON);
  const xRange = [-(xMax * 1.1), xMax * 1.1];

  const { max: rawFiniteYMax } = getFiniteMinMax(displayYValues);
  const pThresholdY = -Math.log10(pValueThreshold);
  const finiteYMax = Number.isFinite(rawFiniteYMax) ? rawFiniteYMax : 0;
  const finiteDomainTop = Math.max(finiteYMax, pThresholdY, 1);
  const infinityBoundaryY = zeroProbabilityIndices.length > 0
    ? finiteDomainTop * 1.08
    : NaN;
  const yAxisTop = zeroProbabilityIndices.length > 0
    ? infinityBoundaryY * 1.08
    : finiteDomainTop * 1.1;
  const yRange = [0, yAxisTop];

  // Give p=0 points a dedicated finite rendering coordinate while preserving
  // +Infinity in the mathematical arrays and 0 in customdata/exports.
  const labelDisplayYValues = new Float64Array(displayYValues);
  for (const index of zeroProbabilityIndices) {
    labelDisplayYValues[index] = infinityBoundaryY;
  }

  const colorscale = [
    [0.0, colors.ns],
    [0.5, colors.down],
    [1.0, colors.up]
  ];

  /** @type {Object[]} */
  const traces = [{
    type: PLOTLY_2D_SCATTER_TRACE_TYPE,
    mode: 'markers',
    name: 'Genes',
    x: pre.log2FoldChange,
    y: displayYValues,
    text: safeGenes,
    customdata: selectedPValues,
    meta: { cellucid: 'volcano', version: 3 },
    marker: {
      // Encode categories as numeric codes to avoid allocating large color-string arrays.
      color: codes,
      cmin: 0,
      cmax: 2,
      colorscale,
      showscale: false,
      size: pointSize,
      opacity: 0.85,
      line: { width: 0 }
    },
    hovertemplate: '<b>%{text}</b><br>' +
      'log₂FC: %{x:.2f}<br>' +
      'p: %{customdata}<br>' +
      '-log₁₀(p): %{y:.2f}<extra></extra>',
    hoverlabel: COMMON_HOVER_STYLE,
    showlegend: false
  }];

  // Legend-only traces so users can read the category colors without splitting the main trace.
  const legendMarkerSize = pointSize;
  traces.push({
    type: PLOTLY_2D_SCATTER_TRACE_TYPE,
    mode: 'markers',
    name: `Up (${up})`,
    x: [0],
    y: [0],
    marker: { color: colors.up, size: legendMarkerSize, opacity: 0.85, line: { width: 0 } },
    visible: 'legendonly',
    hoverinfo: 'skip'
  });
  traces.push({
    type: PLOTLY_2D_SCATTER_TRACE_TYPE,
    mode: 'markers',
    name: `Down (${down})`,
    x: [0],
    y: [0],
    marker: { color: colors.down, size: legendMarkerSize, opacity: 0.85, line: { width: 0 } },
    visible: 'legendonly',
    hoverinfo: 'skip'
  });
  traces.push({
    type: PLOTLY_2D_SCATTER_TRACE_TYPE,
    mode: 'markers',
    name: `Not significant (${ns})`,
    x: [0],
    y: [0],
    marker: { color: colors.ns, size: legendMarkerSize, opacity: 0.85, line: { width: 0 } },
    visible: 'legendonly',
    hoverinfo: 'skip'
  });

  const infinityX = zeroProbabilityIndices.map(index => pre.log2FoldChange[index]);
  const infinityY = zeroProbabilityIndices.map(() => infinityBoundaryY);
  const infinityText = zeroProbabilityIndices.map(index => safeGenes[index]);
  const infinityPValues = zeroProbabilityIndices.map(index => selectedPValues[index]);
  const infinityCodes = Uint8Array.from(
    zeroProbabilityIndices,
    index => codes[index]
  );
  traces.push({
    type: PLOTLY_2D_SCATTER_TRACE_TYPE,
    mode: 'markers',
    name: `p = 0 (+∞ significance) (${zeroProbabilityIndices.length})`,
    x: infinityX,
    y: infinityY,
    text: infinityText,
    customdata: infinityPValues,
    marker: {
      color: infinityCodes,
      cmin: 0,
      cmax: 2,
      colorscale,
      showscale: false,
      symbol: 'triangle-up',
      size: pointSize + 2,
      opacity: 1,
      line: { color: theme.axisLine, width: 1 }
    },
    hovertemplate: '<b>%{text}</b><br>' +
      'log₂FC: %{x:.2f}<br>' +
      'p: 0<br>' +
      '-log₁₀(p): +∞<extra></extra>',
    hoverlabel: COMMON_HOVER_STYLE,
    showlegend: zeroProbabilityIndices.length > 0
  });

  // Build layout using BasePlot utility
  const layout = BasePlot.createLayout({
    showLegend: true
  });

  layout.xaxis = {
    title: {
      text: 'log₂ Fold Change',
      font: { family: 'Oswald, system-ui, sans-serif', size: 12, color: theme.text }
    },
    zeroline: true,
    zerolinecolor: theme.axisLine,
    zerolinewidth: 1,
    range: xRange,
    showgrid: true,
    gridcolor: theme.grid,
    tickfont: { size: 10, color: theme.textMuted }
  };

  layout.yaxis = {
    title: {
      text: useAdjustedPValue ? '-log₁₀ (adjusted p-value)' : '-log₁₀ (p-value)',
      font: { family: 'Oswald, system-ui, sans-serif', size: 12, color: theme.text }
    },
    zeroline: false,
    range: yRange,
    showgrid: true,
    gridcolor: theme.grid,
    tickfont: { size: 10, color: theme.textMuted }
  };

  if (zeroProbabilityIndices.length > 0) {
    const tickValues = [
      0,
      finiteDomainTop * 0.25,
      finiteDomainTop * 0.5,
      finiteDomainTop * 0.75,
      finiteDomainTop,
      infinityBoundaryY
    ];
    layout.yaxis.tickmode = 'array';
    layout.yaxis.tickvals = tickValues;
    layout.yaxis.ticktext = tickValues.map((value, index) => {
      if (index === tickValues.length - 1) return '+∞';
      if (value === 0) return '0';
      if (value >= 100) return value.toFixed(0);
      if (value >= 10) return value.toFixed(1);
      return value.toFixed(2);
    });
  }

  const labelLayout = buildVolcanoAnnotations(
    pre,
    codes,
    mathematicalYValues,
    labelDisplayYValues,
    { labelTopN, highlightGenes },
    viewport,
    xRange,
    yRange
  );
  layout.annotations = labelLayout.annotations;
  layout.meta = {
    cellucidVolcanoLabels: {
      requested: labelLayout.requested,
      displayed: labelLayout.displayed
    }
  };

  // Add threshold lines as shapes
  if (showThresholdLines) {
    layout.shapes = [
      // Horizontal p-value threshold
      {
        type: 'line',
        x0: -(xMax * 1.1),
        x1: xMax * 1.1,
        y0: pThresholdY,
        y1: pThresholdY,
        line: { color: theme.textMuted, width: 1, dash: 'dash' }
      },
      // Vertical fold change thresholds
      {
        type: 'line',
        x0: -foldChangeThreshold,
        x1: -foldChangeThreshold,
        y0: 0,
        y1: yAxisTop,
        line: { color: theme.textMuted, width: 1, dash: 'dash' }
      },
      {
        type: 'line',
        x0: foldChangeThreshold,
        x1: foldChangeThreshold,
        y0: 0,
        y1: yAxisTop,
        line: { color: theme.textMuted, width: 1, dash: 'dash' }
      }
    ];
  }

  // Legend position
  layout.legend = {
    x: 0.5,
    y: -0.14,
    xanchor: 'center',
    yanchor: 'top',
    orientation: 'h',
    bgcolor: theme.legend.bg,
    bordercolor: theme.legend.border,
    borderwidth: 1,
    font: { size: 10 }
  };

  layout.margin = {
    l: VOLCANO_MARGIN_LEFT,
    r: VOLCANO_MARGIN_RIGHT,
    t: labelLayout.marginTop,
    b: VOLCANO_MARGIN_BOTTOM
  };
  applyLegendPosition(layout, options.legendPosition);

  return { traces, layout, config };
}

const volcanoPlotDefinition = {
  id: 'volcanoplot',
  name: 'Volcano Plot',
  description: 'Differential expression visualization showing fold change vs significance',
  supportedTypes: ['differential'],
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
      label: 'Maximum gene labels',
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
    const viewport = requireVolcanoViewport(container);
    const Plotly = await createMinimalPlotly();
    const figure = buildVolcanoFigure(deResults, options, viewport);
    return await Plotly.newPlot(container, figure.traces, figure.layout, figure.config);
  },

  /**
   * Update existing plot using Plotly.react
   * @param {Object} figure - Existing Plotly figure
   * @param {Object} deResults - Differential expression results
   * @param {Object} options - Plot options
   * @returns {Promise<Object>} Updated Plotly figure
   */
  async update(figure, deResults, options) {
    const viewport = requireVolcanoViewport(figure);
    const Plotly = await createMinimalPlotly();
    const nextFigure = buildVolcanoFigure(deResults, options, viewport);

    const hasExpectedTrace = (
      figure?.data?.[0]?.meta?.cellucid === 'volcano' &&
      figure?.data?.[0]?.meta?.version === 3
    );
    if (!hasExpectedTrace) {
      throw new TypeError(
        'Volcano plot update requires the current version 3 figure contract'
      );
    }
    if (typeof Plotly.react !== 'function') {
      throw new TypeError('Volcano plot update requires Plotly.react');
    }

    return await Plotly.react(
      figure,
      nextFigure.traces,
      nextFigure.layout,
      nextFigure.config
    );
  },

  /**
   * Export volcano plot data as CSV
   * Exports full differential expression table
   * @param {Object} deResults - Differential expression results
   * @param {Object} options - Plot options
   * @returns {Object} { rows, columns, metadata }
   */
  exportCSV(deResults, options) {
    requireVolcanoOptions(options);
    const { pValueThreshold, foldChangeThreshold, useAdjustedPValue } = options;
    const results = requireDEResults(deResults);

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

    /** @type {Array<{row: Object, selectedPValue: number, index: number}>} */
    const rankedRows = [];

    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result === null || typeof result !== 'object' || Array.isArray(result)) {
        throw new TypeError(`Volcano result at index ${index} must be an object`);
      }
      if (typeof result.gene !== 'string' || result.gene.length === 0) {
        throw new TypeError(`Volcano result at index ${index} must have a non-empty gene`);
      }

      const rawPValue = readProbability(result.pValue, 'pValue', result.gene);
      const adjustedPValue = readProbability(
        result.adjustedPValue,
        'adjustedPValue',
        result.gene
      );
      const pVal = useAdjustedPValue
        ? adjustedPValue
        : rawPValue;

      const log2FoldChange = readOptionalFiniteNumber(
        result.log2FoldChange,
        'log2FoldChange',
        result.gene
      );

      const isSignificant =
        isFiniteNumber(pVal) &&
        isFiniteNumber(log2FoldChange) &&
        pVal < pValueThreshold &&
        Math.abs(log2FoldChange) >= foldChangeThreshold;

      let direction = 'ns';
      if (isSignificant) {
        direction = log2FoldChange > 0 ? 'up' : 'down';
      }

      const meanA = readOptionalFiniteNumber(result.meanA, 'meanA', result.gene);
      const meanB = readOptionalFiniteNumber(result.meanB, 'meanB', result.gene);
      rankedRows.push({
        index,
        selectedPValue: pVal,
        row: {
          gene: result.gene,
          log2FoldChange: isFiniteNumber(log2FoldChange) ? log2FoldChange : '',
          pValue: isFiniteNumber(rawPValue) ? rawPValue : '',
          adjustedPValue: isFiniteNumber(adjustedPValue) ? adjustedPValue : '',
          negLog10P: pVal === 0
            ? '+Infinity'
            : (isFiniteNumber(pVal) ? -Math.log10(pVal) : ''),
          meanA: isFiniteNumber(meanA) ? meanA : '',
          meanB: isFiniteNumber(meanB) ? meanB : '',
          significant: isSignificant ? 'yes' : 'no',
          direction
        }
      });
    }

    // Sort by significance (most significant first)
    rankedRows.sort((a, b) => {
      const aUnavailable = Number.isNaN(a.selectedPValue);
      const bUnavailable = Number.isNaN(b.selectedPValue);
      if (aUnavailable !== bUnavailable) return aUnavailable ? 1 : -1;
      if (!aUnavailable && a.selectedPValue !== b.selectedPValue) {
        return a.selectedPValue - b.selectedPValue;
      }
      return a.index - b.index;
    });
    const rows = rankedRows.map(entry => entry.row);

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
    requireVolcanoOptions(options);
    const { pValueThreshold, foldChangeThreshold, useAdjustedPValue } = options;
    const results = requireDEResults(deResults);

    let upregulated = 0;
    let downregulated = 0;
    let notSignificant = 0;

    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result === null || typeof result !== 'object' || Array.isArray(result)) {
        throw new TypeError(`Volcano result at index ${index} must be an object`);
      }
      if (typeof result.gene !== 'string' || result.gene.length === 0) {
        throw new TypeError(`Volcano result at index ${index} must have a non-empty gene`);
      }
      const pVal = useAdjustedPValue
        ? readProbability(result.adjustedPValue, 'adjustedPValue', result.gene)
        : readProbability(result.pValue, 'pValue', result.gene);
      const foldChange = readOptionalFiniteNumber(
        result.log2FoldChange,
        'log2FoldChange',
        result.gene
      );

      if (!isFiniteNumber(pVal) || !isFiniteNumber(foldChange)) {
        notSignificant++;
        continue;
      }

      const isSignificant = pVal < pValueThreshold;
      const hasLargeFoldChange = Math.abs(foldChange) >= foldChangeThreshold;

      if (isSignificant && hasLargeFoldChange) {
        if (foldChange > 0) {
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
