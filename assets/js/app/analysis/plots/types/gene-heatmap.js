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
import { getPlotTheme } from '../../shared/plot-theme.js';

function truncateLabel(label, maxLen) {
  if (typeof label !== 'string') {
    throw new TypeError('Heatmap labels must be strings');
  }
  if (!Number.isSafeInteger(maxLen) || maxLen < 2) {
    throw new RangeError('Heatmap label length must be an integer of at least 2');
  }
  if (label.length <= maxLen) return label;
  if (maxLen <= 1) return '…';
  const keep = maxLen - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return label.slice(0, head) + '…' + label.slice(label.length - tail);
}

function buildSparseTicks(labels, maxTicks, truncateLen = null) {
  if (!Array.isArray(labels) || labels.some(label => typeof label !== 'string')) {
    throw new TypeError('Heatmap tick labels must be an array of strings');
  }
  if (!Number.isSafeInteger(maxTicks) || maxTicks < 2) {
    throw new RangeError('Heatmap maximum tick count must be an integer of at least 2');
  }
  if (truncateLen !== null && (!Number.isSafeInteger(truncateLen) || truncateLen < 2)) {
    throw new RangeError('Heatmap tick truncation length must be null or an integer of at least 2');
  }
  const items = labels;
  const n = labels.length;
  if (n === 0) return {};

  if (n <= maxTicks) {
    return truncateLen
      ? { tickmode: 'array', tickvals: items, ticktext: items.map((l) => truncateLabel(l, truncateLen)) }
      : {};
  }

  const step = Math.ceil(n / maxTicks);
  const tickvals = [];
  const ticktext = [];
  for (let i = 0; i < n; i += step) {
    const v = items[i];
    tickvals.push(v);
    ticktext.push(truncateLen ? truncateLabel(v, truncateLen) : v);
  }

  // Ensure the final label is included for context.
  if (tickvals[tickvals.length - 1] !== items[n - 1]) {
    tickvals.push(items[n - 1]);
    ticktext.push(truncateLen ? truncateLabel(items[n - 1], truncateLen) : items[n - 1]);
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
    transform: 'zscore',
    showValues: false,
    reverseColorscale: true,
    rangeMode: 'auto',
    zmin: -3,
    zmax: 3,
    // Marker selection controls (used by GenesPanelUI to rebuild markers/heatmap)
    pValueThreshold: 0.05,
    foldChangeThreshold: 1.0,
    useAdjustedPValue: true,
    // Internal flag for modal option visibility; set by UI depending on whether
    // clustering/dendrogram data is available for this figure.
    hasClustering: false,
    showRowDendrogram: true,
    showColDendrogram: true
  },

  optionSchema: {
    pValueThreshold: {
      type: 'range',
      label: 'P-value threshold',
      min: 0,
      max: 0.2,
      step: 0.001
    },
    foldChangeThreshold: {
      type: 'range',
      label: '|log2FC| threshold',
      min: 0,
      max: 5,
      step: 0.1
    },
    useAdjustedPValue: { type: 'checkbox', label: 'Use FDR-corrected p-values' },
    transform: {
      type: 'select',
      label: 'Transform',
      options: [
        { value: 'zscore', label: 'Z-score' },
        { value: 'log1p', label: 'Log(1+x)' },
        { value: 'none', label: 'None' }
      ]
    },
    showRowDendrogram: {
      type: 'checkbox',
      label: 'Show gene dendrogram',
      showWhen: (opts) => opts?.hasClustering === true
    },
    showColDendrogram: {
      type: 'checkbox',
      label: 'Show group dendrogram',
      showWhen: (opts) => opts?.hasClustering === true
    },
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
      showWhen: (opts) => opts?.rangeMode === 'fixed'
    },
    zmax: {
      type: 'range',
      label: 'Color max (zmax)',
      min: -6,
      max: 6,
      step: 0.1,
      showWhen: (opts) => opts?.rangeMode === 'fixed'
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
      colorscale,
      showValues,
      reverseColorscale,
      rangeMode,
      zmin,
      zmax
    } = options;
    if (typeof colorscale !== 'string' || colorscale.length === 0) {
      throw new TypeError('Heatmap colorscale must be a non-empty string');
    }
    if (typeof showValues !== 'boolean' || typeof reverseColorscale !== 'boolean') {
      throw new TypeError('Heatmap display options must be booleans');
    }
    if (!['auto', 'zscore', 'fixed'].includes(rangeMode)) {
      throw new RangeError(`Unknown heatmap rangeMode: ${String(rangeMode)}`);
    }

    const theme = getPlotTheme();

    const { values, genes, groupNames, nRows, nCols } = data.matrix;
    const transform = data.matrix.transform;
    if (!['none', 'zscore', 'log1p'].includes(transform)) {
      throw new RangeError(`Unknown heatmap matrix transform: ${String(transform)}`);
    }
    if (!Number.isSafeInteger(nRows) || nRows < 1 || !Number.isSafeInteger(nCols) || nCols < 1) {
      throw new RangeError('Heatmap matrix dimensions must be positive integers');
    }
    if ((!Array.isArray(values) && !ArrayBuffer.isView(values)) || values.length !== nRows * nCols) {
      throw new TypeError('Heatmap matrix values must match nRows × nCols exactly');
    }
    if (!Array.isArray(genes) || genes.length !== nRows || genes.some(gene => typeof gene !== 'string')) {
      throw new TypeError('Heatmap genes must contain one string for every matrix row');
    }
    if (
      !Array.isArray(groupNames) ||
      groupNames.length !== nCols ||
      groupNames.some(group => typeof group !== 'string')
    ) {
      throw new TypeError('Heatmap groupNames must contain one string for every matrix column');
    }
    const clustering = data.clustering === undefined ? null : data.clustering;
    if (clustering !== null && (typeof clustering !== 'object' || Array.isArray(clustering))) {
      throw new TypeError('Heatmap clustering must be an object or null');
    }
    const showRowDendrogram = options.showRowDendrogram;
    const showColDendrogram = options.showColDendrogram;
    if (typeof showRowDendrogram !== 'boolean' || typeof showColDendrogram !== 'boolean') {
      throw new TypeError('Heatmap dendrogram display options must be booleans');
    }

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

    // NOTE: We intentionally use the standard `heatmap` trace.
    // In some environments Plotly's `heatmapgl` can render blank (especially when
    // toggling "Show values"), so prioritize correctness over GPU acceleration.
    const traceType = 'heatmap';

    let colorRange = { zauto: true };
    if (rangeMode === 'zscore') {
      colorRange = { zauto: false, zmin: -3, zmax: 3 };
    } else if (rangeMode === 'fixed') {
      if (!Number.isFinite(zmin) || !Number.isFinite(zmax)) {
        throw new TypeError('Fixed heatmap range requires finite zmin and zmax');
      }
      if (zmin >= zmax) {
        throw new RangeError('Fixed heatmap range requires zmin less than zmax');
      }
      colorRange = { zauto: false, zmin, zmax };
    }

    const trace = {
      type: traceType,
      z,
      x: genes,
      y: groupNames,
      colorscale,
      reversescale: reverseColorscale,
      ...colorRange,
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

    const pushDendrogramTraces = (dendrogram, order, axisName) => {
      if (!dendrogram || typeof dendrogram !== 'object') {
        throw new TypeError(`Heatmap ${axisName} dendrogram root is required`);
      }
      if (!Array.isArray(order) || order.length === 0) {
        throw new TypeError(`Heatmap ${axisName} dendrogram order is required`);
      }
      if (new Set(order).size !== order.length) {
        throw new TypeError(`Heatmap ${axisName} dendrogram order must contain unique leaf IDs`);
      }

      const leafPos = new Map();
      for (let i = 0; i < order.length; i++) {
        leafPos.set(order[i], i);
      }

      const xs = [];
      const ys = [];

      const walk = (node) => {
        if (!node || typeof node !== 'object') {
          throw new TypeError(`Heatmap ${axisName} dendrogram contains an invalid node`);
        }
        if (node.isLeaf) {
          if (!leafPos.has(node.id)) {
            throw new RangeError(
              `Heatmap ${axisName} dendrogram leaf ${String(node.id)} is absent from its order`
            );
          }
          const x = leafPos.get(node.id);
          return { x, y: 0 };
        }
        if (!Number.isFinite(node.height) || node.height < 0) {
          throw new TypeError(`Heatmap ${axisName} dendrogram heights must be finite and non-negative`);
        }

        const left = walk(node.left);
        const right = walk(node.right);
        const x = (left.x + right.x) / 2;
        const y = node.height;

        // vertical left
        xs.push(left.x, left.x, null);
        ys.push(left.y, y, null);
        // vertical right
        xs.push(right.x, right.x, null);
        ys.push(right.y, y, null);
        // horizontal
        xs.push(left.x, right.x, null);
        ys.push(y, y, null);

        return { x, y };
      };

      walk(dendrogram);

      if (axisName === 'row') {
        traces.push({
          type: 'scatter',
          mode: 'lines',
          x: xs,
          y: ys,
          xaxis: 'x2',
          yaxis: 'y2',
          line: { color: theme.axisLine, width: 1 },
          hoverinfo: 'skip',
          showlegend: false
        });
      } else {
        // col dendrogram: swap axes (distance on x, order position on y)
        traces.push({
          type: 'scatter',
          mode: 'lines',
          x: ys,
          y: xs,
          xaxis: 'x3',
          yaxis: 'y3',
          line: { color: theme.axisLine, width: 1 },
          hoverinfo: 'skip',
          showlegend: false
        });
      }
    };

    if (showRowDendrogram && clustering !== null) {
      pushDendrogramTraces(clustering.rowDendrogram, clustering.rowOrder, 'row');
    }
    if (showColDendrogram && clustering !== null) {
      pushDendrogramTraces(clustering.colDendrogram, clustering.colOrder, 'col');
    }

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
    const maxGeneLen = genes.reduce((max, gene) => {
      if (typeof gene !== 'string') {
        throw new TypeError('Heatmap gene labels must be strings');
      }
      return Math.max(max, gene.length);
    }, 0);
    const rotateLabels = nGenes > 8 || maxGeneLen > 10;
    const tickAngle = rotateLabels ? -35 : 0;
    const xTickFontSize = Math.min(10, Math.max(6, Math.floor(220 / Math.max(10, nGenes))));
    const yTickFontSize = Math.min(10, Math.max(7, Math.floor(160 / Math.max(4, nGroups))));

    const clustering = data.clustering === undefined ? null : data.clustering;
    const showRowDendrogram =
      options.showRowDendrogram === true &&
      clustering !== null &&
      clustering.rowDendrogram !== undefined &&
      clustering.rowOrder !== undefined;
    const showColDendrogram =
      options.showColDendrogram === true &&
      clustering !== null &&
      clustering.colDendrogram !== undefined &&
      clustering.colOrder !== undefined;

    const dendroFrac = 0.18;
    // Row dendrogram is drawn above the heatmap (aligned to x).
    const topFrac = showRowDendrogram ? dendroFrac : 0;
    // Column dendrogram is drawn to the RIGHT of the heatmap (aligned to y).
    const rightFrac = showColDendrogram ? dendroFrac : 0;

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
      domain: [0, 1 - rightFrac],
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
      fixedrange: false,
      domain: [0, 1 - topFrac]
    };

    if (showRowDendrogram) {
      layout.xaxis2 = {
        domain: [0, 1 - rightFrac],
        showticklabels: false,
        showgrid: false,
        zeroline: false
      };
      layout.yaxis2 = {
        domain: [1 - topFrac, 1],
        showticklabels: false,
        showgrid: false,
        zeroline: false
      };
    }

    if (showColDendrogram) {
      layout.xaxis3 = {
        domain: [1 - rightFrac, 1],
        showticklabels: false,
        showgrid: false,
        zeroline: false
      };
      layout.yaxis3 = {
        domain: [0, 1 - topFrac],
        showticklabels: false,
        showgrid: false,
        zeroline: false,
        autorange: 'reversed'
      };
    }

    // Adjust margins based on content
    const groupLabelWidth = Math.max(
      40,
      groupNames.reduce((max, group) => {
        if (typeof group !== 'string') {
          throw new TypeError('Heatmap group labels must be strings');
        }
        return Math.max(max, Math.min(22, group.length) * 6);
      }, 0)
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
