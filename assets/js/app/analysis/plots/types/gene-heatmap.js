/**
 * Gene Heatmap Plot Type
 *
 * Expression heatmap for marker genes panel.
 * Shows groups (rows) vs genes (columns) for better sidebar readability.
 *
 * Features:
 * - GPU-accelerated rendering (heatmapgl)
 * - Cell hover with detailed stats
 * - Color scale customization
 * - Value annotations
 *
 * @module plots/types/gene-heatmap
 */

import { PlotFactory, PlotRegistry, BasePlot, COMMON_HOVER_STYLE } from '../plot-factory.js';
import { getHeatmapTraceType } from '../plotly-loader.js';
import { getPlotTheme } from '../../shared/plot-theme.js';
import { getMatrixMinMax } from '../../shared/matrix-utils.js';

function truncateLabel(label, maxLen) {
  const text = String(label ?? '');
  if (!Number.isFinite(maxLen) || maxLen <= 0) return text;
  if (text.length <= maxLen) return text;
  if (maxLen <= 1) return '…';
  const keep = maxLen - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return text.slice(0, head) + '…' + (tail > 0 ? text.slice(text.length - tail) : '');
}

function buildSparseTicks(labels, maxTicks, truncateLen = null) {
  const items = Array.isArray(labels) ? labels : [];
  const n = items.length;
  if (n === 0) return {};

  const max = Number.isFinite(maxTicks) ? Math.max(2, Math.floor(maxTicks)) : n;
  if (n <= max) {
    return truncateLen
      ? { tickmode: 'array', tickvals: items, ticktext: items.map((l) => truncateLabel(l, truncateLen)) }
      : {};
  }

  const step = Math.ceil(n / max);
  const tickvals = [];
  const ticktext = [];
  for (let i = 0; i < n; i += step) {
    const v = items[i];
    tickvals.push(v);
    ticktext.push(truncateLen ? truncateLabel(v, truncateLen) : String(v ?? ''));
  }

  // Ensure the final label is included for context.
  if (tickvals[tickvals.length - 1] !== items[n - 1]) {
    tickvals.push(items[n - 1]);
    ticktext.push(truncateLen ? truncateLabel(items[n - 1], truncateLen) : String(items[n - 1] ?? ''));
  }

  return { tickmode: 'array', tickvals, ticktext };
}

const geneHeatmapDefinition = {
  id: 'gene-heatmap',
  name: 'Gene Heatmap',
  description: 'Expression heatmap for marker genes',
  supportedTypes: ['expression_matrix'],
  supportedLayouts: ['single'],
  supportsLegend: false,

  defaultOptions: {
    colorscale: 'RdBu',
    showValues: false,
    reverseColorscale: true,
    rangeMode: 'auto',
    zmin: -3,
    zmax: 3
  },

  optionSchema: {
    colorscale: {
      type: 'select',
      label: 'Colors',
      options: [
        { value: 'RdBu', label: 'Red-Blue (diverging)' },
        { value: 'Viridis', label: 'Viridis' },
        { value: 'Blues', label: 'Blues' },
        { value: 'YlOrRd', label: 'Yellow-Red' },
        { value: 'Greens', label: 'Greens' }
      ]
    },
    showValues: { type: 'checkbox', label: 'Show values' },
    reverseColorscale: { type: 'checkbox', label: 'Reverse colors' },
    rangeMode: {
      type: 'select',
      label: 'Color range',
      options: [
        { value: 'auto', label: 'Auto' },
        { value: 'zscore', label: 'Z-score default (-3..3)' },
        { value: 'fixed', label: 'Fixed (zmin/zmax)' }
      ]
    },
    zmin: {
      type: 'range',
      label: 'Color min (zmin)',
      min: -6,
      max: 6,
      step: 0.1,
      showWhen: (opts) => opts?.rangeMode === 'fixed' || opts?.rangeMode === 'zscore'
    },
    zmax: {
      type: 'range',
      label: 'Color max (zmax)',
      min: -6,
      max: 6,
      step: 0.1,
      showWhen: (opts) => opts?.rangeMode === 'fixed' || opts?.rangeMode === 'zscore'
    }
  },

  /**
   * Build traces for the heatmap
   *
   * @param {Object} data - Expression matrix data
   * @param {Object} options - Plot options
   * @returns {Object[]} Plotly traces
   */
  buildTraces(data, options) {
    const {
      colorscale = 'RdBu',
      showValues = false,
      reverseColorscale = true,
      rangeMode = 'auto',
      zmin,
      zmax
    } = options;

    const theme = getPlotTheme();

    const { values, genes, groupNames, nRows, nCols } = data.matrix;
    const transform = data.matrix.transform || 'none';

    // Convert Float32Array to 2D array for Plotly.
    // Display is transposed: groups (rows) x genes (cols).
    // Avoid allocating `text` when not needed (large heatmaps).
    const z = new Array(nCols);
    const text = showValues ? new Array(nCols) : null;

    for (let g = 0; g < nCols; g++) {
      const row = new Array(nRows);
      const textRow = showValues ? new Array(nRows) : null;

      for (let r = 0; r < nRows; r++) {
        const v = values[r * nCols + g];
        const finite = Number.isFinite(v);
        // Plotly treats `null` as missing (renders as empty cell and doesn't
        // distort autoscaling).
        row[r] = finite ? v : null;
        if (showValues && textRow) {
          textRow[r] = finite ? v.toFixed(2) : '';
        }
      }

      z[g] = row;
      if (showValues && text && textRow) {
        text[g] = textRow;
      }
    }

    const traces = [];

    // Prefer WebGL for large matrices, but force standard heatmap when value
    // annotations are enabled (heatmapgl does not reliably support them).
    const traceType = showValues ? 'heatmap' : getHeatmapTraceType();

    // Color range strategy:
    // - Z-score: default to a symmetric fixed range so colors are comparable across runs.
    // - Other transforms: default to autoscale (raw units vary by dataset).
    const mode = (rangeMode === 'fixed' || rangeMode === 'zscore' || rangeMode === 'auto')
      ? rangeMode
      : 'auto';
    const effectiveMode = (mode === 'auto' && transform === 'zscore') ? 'zscore' : mode;
    const wantsFixed = effectiveMode !== 'auto';

    let traceZmin;
    let traceZmax;
    let zauto = !wantsFixed;

    if (wantsFixed) {
      const fallback = effectiveMode === 'zscore'
        ? { min: -3, max: 3 }
        : getMatrixMinMax(values);

      const minVal = Number.isFinite(zmin) ? zmin : fallback.min;
      const maxVal = Number.isFinite(zmax) ? zmax : fallback.max;

      // Ensure a valid range; fall back to autoscale if not.
      if (Number.isFinite(minVal) && Number.isFinite(maxVal) && minVal < maxVal) {
        traceZmin = minVal;
        traceZmax = maxVal;
        zauto = false;
      } else {
        zauto = true;
      }
    }

    const trace = {
      type: traceType,
      z,
      x: genes,
      y: groupNames,
      colorscale,
      reversescale: reverseColorscale,
      ...(zauto ? { zauto: true } : { zmin: traceZmin, zmax: traceZmax }),
      showscale: true,
      colorbar: {
        orientation: 'h',
        thickness: 10,
        len: 0.6,
        x: 0.5,
        xanchor: 'center',
        y: -0.25,
        yanchor: 'top',
        tickfont: {
          family: theme.fontFamily,
          size: 9,
          color: theme.textMuted
        },
        title: {
          text: transform === 'zscore' ? 'Z-score' : (transform === 'log1p' ? 'log(1+x)' : 'Expression'),
          side: 'top',
          font: {
            family: 'Oswald, system-ui, sans-serif',
            size: 10,
            color: theme.text
          }
        }
      },
      hovertemplate: '<b>%{x}</b><br>' +
        'Group: %{y}<br>' +
        'Value: %{z:.2f}<extra></extra>',
      hoverlabel: COMMON_HOVER_STYLE
    };

    if (showValues) {
      trace.text = text;
      trace.texttemplate = '%{text}';
      trace.textfont = {
        family: theme.fontFamily,
        size: Math.min(10, Math.max(6, 100 / Math.max(1, nCols)))
      };
    }

    traces.push(trace);

    return traces;
  },

  /**
   * Build layout for the heatmap
   *
   * @param {Object} data - Expression matrix data
   * @param {Object} options - Plot options
   * @returns {Object} Plotly layout
   */
  buildLayout(data, options) {
    const theme = getPlotTheme();
    const layout = BasePlot.createLayout({ showLegend: false });

    const { genes, groupNames } = data.matrix;
    const nGenes = genes.length;
    const nGroups = groupNames.length;

    // Determine if we need to rotate labels
    const maxGeneLen = genes.reduce((max, g) => Math.max(max, String(g ?? '').length), 0);
    const rotateLabels = nGenes > 8 || maxGeneLen > 10;
    const tickAngle = rotateLabels ? -35 : 0;
    const xTickFontSize = Math.min(10, Math.max(6, Math.floor(220 / Math.max(10, nGenes))));
    const yTickFontSize = Math.min(10, Math.max(7, Math.floor(160 / Math.max(4, nGroups))));

    layout.xaxis = {
      title: '',
      tickangle: tickAngle,
      automargin: true,
      tickfont: {
        family: theme.fontFamily,
        size: xTickFontSize,
        color: theme.text
      },
      side: 'bottom',
      fixedrange: false,
      ...buildSparseTicks(genes, 40, 14)
    };

    layout.yaxis = {
      title: '',
      automargin: true,
      tickfont: {
        family: theme.fontFamily,
        size: yTickFontSize,
        color: theme.text
      },
      autorange: 'reversed', // First group at top
      fixedrange: false
    };

    // Adjust margins based on content
    const groupLabelWidth = Math.max(
      40,
      groupNames.reduce((max, g) => Math.max(max, Math.min(22, String(g ?? '').length) * 6), 0)
    );
    layout.margin = {
      l: Math.min(220, Math.max(60, groupLabelWidth)),
      r: 20,
      t: 30,
      // Extra space for rotated gene labels + horizontal colorbar.
      b: rotateLabels ? 140 : 110
    };

    return layout;
  },

  /**
   * Render the heatmap
   */
  async render(data, options, container, layoutEngine) {
    return PlotFactory.render({
      definition: this,
      pageData: data,
      options,
      container,
      layoutEngine
    });
  },

  /**
   * Update an existing heatmap
   */
  async update(figure, data, options, layoutEngine) {
    return PlotFactory.update({
      definition: this,
      figure,
      pageData: data,
      options,
      layoutEngine
    });
  },

  /**
   * Export heatmap data to CSV
   */
  exportCSV(data, options) {
    const { matrix } = data;
    const { genes, groupNames, values, nRows, nCols, transform } = matrix;

    const rows = [];
    const columns = ['gene', ...groupNames];

    for (let r = 0; r < nRows; r++) {
      const row = { gene: genes[r] };
      for (let c = 0; c < nCols; c++) {
        row[groupNames[c]] = values[r * nCols + c].toFixed(4);
      }
      rows.push(row);
    }

    return {
      rows,
      columns,
      metadata: {
        plotType: 'gene-heatmap',
        transform,
        geneCount: nRows,
        groupCount: nCols,
        exportDate: new Date().toISOString()
      }
    };
  }
};

PlotRegistry.register(geneHeatmapDefinition);
export default geneHeatmapDefinition;
