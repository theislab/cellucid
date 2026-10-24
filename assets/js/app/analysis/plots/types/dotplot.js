/**
 * Dot plot and matrix plot of genes across cell groups (scanpy
 * `pl.dotplot` / `pl.matrixplot`).
 *
 * Each dot is one gene in one group: its colour the gene's (scaled) mean
 * expression there, its area the fraction of the group's cells expressing it.
 * As in scanpy the dot area grows as the fraction to the power 1.5, scaled so
 * the largest fraction (rounded up to the next 10%) fills the largest dot.
 * Genes given as named sets are bracketed and labelled above the plot. The
 * matrix plot is the same table as coloured cells without the sizes.
 *
 * Data (built by `ui/analysis-types/dotplot-ui.js`):
 *   genes        gene names, in plot order
 *   geneSets     [{name, start, end}] index ranges of `genes` (end exclusive)
 *   groups       group names, in plot order
 *   color        Float64Array, gene-major (`color[gene * groups + group]`)
 *   fraction     Float64Array, gene-major, 0–1
 *   mean         Float64Array, gene-major, unscaled (for hover and export)
 *   cellCounts   number[] cells per group
 *   colorLabel   the colour bar title
 *   colorMap     'Reds' | 'Viridis' | 'Blues'
 *   maxDotSize   'auto' or a diameter in px
 *   cellSizePx   the room one row/column gets, for the automatic largest dot
 *   plotHeightPx the plot's height, for the size legend's rows
 *   layout       'dot' | 'matrix'
 *   swap         genes down and groups across
 *
 * @module plots/types/dotplot
 */

import { PlotFactory, PlotRegistry, BasePlot, COMMON_HOVER_STYLE } from '../plot-factory.js';
import { getPlotTheme } from '../../shared/plot-theme.js';
import { escapeHtml } from '../../../utils/dom-utils.js';

/**
 * The color maps, as matplotlib draws them (scanpy's defaults come from
 * there): low values light, high values dark (Reds, Blues) or bright
 * (Viridis).
 */
export const DOTPLOT_COLOR_MAPS = Object.freeze({
  Reds: [[0, '#fff5f0'], [0.25, '#fcbba1'], [0.5, '#fb6a4a'], [0.75, '#cb181d'], [1, '#67000d']],
  Blues: [[0, '#f7fbff'], [0.25, '#c6dbef'], [0.5, '#6baed6'], [0.75, '#2171b5'], [1, '#08306b']],
  Viridis: [[0, '#440154'], [0.25, '#3b528b'], [0.5, '#21918c'], [0.75, '#5ec962'], [1, '#fde725']]
});

/** The color of `t` (0–1) on a color map. */
function colorAt(map, t) {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  let at = 1;
  while (at < map.length - 1 && map[at][0] < clamped) at += 1;
  const [t0, c0] = map[at - 1];
  const [t1, c1] = map[at];
  const f = t1 > t0 ? (clamped - t0) / (t1 - t0) : 0;
  const channel = (hex, offset) => Number.parseInt(hex.slice(offset, offset + 2), 16);
  const mix = offset => Math.round(channel(c0, offset) + (channel(c1, offset) - channel(c0, offset)) * f);
  return `rgb(${mix(1)}, ${mix(3)}, ${mix(5)})`;
}

/** scanpy's `size_exponent`. */
const SIZE_EXPONENT = 1.5;
/** Fractions the size legend shows. */
const LEGEND_FRACTIONS = [0.2, 0.4, 0.6, 0.8, 1];
/** The share of the plot's height the size legend takes. */
const LEGEND_DOMAIN = 0.5;

/**
 * The fraction the largest dot stands for: the largest fraction rounded up
 * to the next 10% (scanpy `dot_max`), never 0.
 *
 * @param {Float64Array} fraction
 */
export function dotMaxFraction(fraction) {
  let max = 0;
  for (const value of fraction) if (Number.isFinite(value) && value > max) max = value;
  return max > 0 ? Math.min(1, Math.ceil(max * 10 - 1e-9) / 10) : 1;
}

/**
 * A dot's diameter in pixels: area ∝ (fraction / dotMax)^1.5.
 *
 * @param {number} fraction
 * @param {number} dotMax
 * @param {number} largestPx
 */
export function dotDiameter(fraction, dotMax, largestPx) {
  if (!Number.isFinite(fraction) || fraction <= 0) return 0;
  const scaled = Math.min(1, fraction / dotMax);
  return largestPx * Math.sqrt(scaled ** SIZE_EXPONENT);
}

/**
 * The largest dot: as asked, or (automatic) 90% of the room one row or
 * column gets, between 6 and 28 px.
 */
function largestDot(data) {
  if (data.maxDotSize !== 'auto') return Number(data.maxDotSize);
  return Math.max(6, Math.min(28, data.cellSizePx * 0.9));
}

/** The height of one row of the size legend, from the plot's height. */
function legendRowPx(data) {
  return (data.plotHeightPx * LEGEND_DOMAIN) / LEGEND_FRACTIONS.length * 0.85;
}

function axisNames(data, swap) {
  return swap
    ? { across: data.groups, down: data.genes, acrossTitle: '', downTitle: '' }
    : { across: data.genes, down: data.groups, acrossTitle: '', downTitle: '' };
}

/**
 * A stacked violin: in each cell of the grid one violin of the gene's values
 * in the group, the values running up the cell and the share of cells at
 * each value across it, filled by the cell's color value. Each gene's
 * violins share one value scale and one width scale.
 */
function violinTraces(data, colorscale, colorbar, escapedGenes, escapedGroups) {
  const swap = data.swap === true;
  const geneCount = data.genes.length;
  const groupCount = data.groups.length;
  const { bins, density, range } = data;
  // The color values' span, for the fills.
  let low = Infinity;
  let high = -Infinity;
  for (const value of data.color) {
    if (!Number.isFinite(value)) continue;
    if (value < low) low = value;
    if (value > high) high = value;
  }
  const span = high > low ? high - low : 1;
  const traces = [];
  for (let gene = 0; gene < geneCount; gene++) {
    let widest = 0;
    for (let at = gene * groupCount * bins; at < (gene + 1) * groupCount * bins; at++) {
      if (density[at] > widest) widest = density[at];
    }
    for (let group = 0; group < groupCount; group++) {
      const across = swap ? group : gene;
      const down = swap ? gene : group;
      const base = (gene * groupCount + group) * bins;
      const up = [];
      for (let bin = 0; bin < bins; bin++) {
        const half = widest > 0 ? (density[base + bin] / widest) * 0.45 : 0;
        // The cell runs from down + 0.45 (lowest value) to down - 0.45 (highest).
        up.push([half, down + 0.45 - ((bin + 0.5) / bins) * 0.9]);
      }
      const x = [...up.map(([half]) => across + half), ...up.reverse().map(([half]) => across - half)];
      const y = [...up.map(([, level]) => level).reverse(), ...up.map(([, level]) => level)];
      const at = gene * groupCount + group;
      traces.push({
        type: 'scatter',
        mode: 'lines',
        x,
        y,
        fill: 'toself',
        fillcolor: colorAt(colorscale, (data.color[at] - low) / span),
        line: { width: 0.5, color: 'rgba(0, 0, 0, 0.35)' },
        hoveron: 'fills',
        text: `${escapedGenes[gene]} in ${escapedGroups[group]}: mean ${data.mean[at].toPrecision(3)} · `
          + `${(data.fraction[at] * 100).toFixed(1)}% expressing · values ${range[2 * gene].toPrecision(3)} to ${range[2 * gene + 1].toPrecision(3)}`,
        hoverinfo: 'text',
        hoverlabel: COMMON_HOVER_STYLE,
        showlegend: false
      });
    }
  }
  // The color bar, on an invisible marker.
  traces.push({
    type: 'scatter',
    mode: 'markers',
    x: [null],
    y: [null],
    marker: { size: 0, color: [low, high], cmin: low, cmax: high, colorscale, showscale: true, colorbar },
    hoverinfo: 'skip',
    showlegend: false
  });
  return traces;
}

const dotplotDefinition = {
  id: 'dotplot',
  name: 'Dot plot',
  description: 'Mean expression and fraction of cells expressing, per gene and group',
  supportedTypes: ['group_summary'],
  supportedLayouts: ['single'],
  supportsLegend: false,
  // Every gene and group is named; the labels shrink to fit instead.
  fitTickLabels: false,

  // Colour map and dot size are the analysis's own options (Layout), carried
  // in the data, so the expanded view has no second copy of them.
  defaultOptions: {},
  optionSchema: {},

  buildTraces(data) {
    const theme = getPlotTheme();
    const swap = data.swap === true;
    const matrix = data.layout === 'matrix';
    const geneCount = data.genes.length;
    const groupCount = data.groups.length;
    if (geneCount === 0 || groupCount === 0) return [];
    const escapedGenes = data.genes.map(gene => escapeHtml(gene));
    const escapedGroups = data.groups.map(group => escapeHtml(group));
    const colorscale = DOTPLOT_COLOR_MAPS[data.colorMap];
    const colorbar = {
      thickness: 10,
      len: 0.38,
      y: 1,
      yanchor: 'top',
      x: 1.02,
      xanchor: 'left',
      outlinewidth: 0,
      tickfont: { family: theme.fontFamily, size: 9, color: theme.textMuted },
      title: {
        text: escapeHtml(data.colorLabel),
        side: 'right',
        font: { family: theme.fontFamily, size: 10, color: theme.text }
      }
    };

    if (data.layout === 'violin') return violinTraces(data, colorscale, colorbar, escapedGenes, escapedGroups);

    if (matrix) {
      // Rows down, columns across; the colour of each cell.
      const z = [];
      const text = [];
      const downCount = swap ? geneCount : groupCount;
      const acrossCount = swap ? groupCount : geneCount;
      for (let d = 0; d < downCount; d++) {
        const row = [];
        const textRow = [];
        for (let a = 0; a < acrossCount; a++) {
          const gene = swap ? d : a;
          const group = swap ? a : d;
          const at = gene * groupCount + group;
          row.push(Number.isFinite(data.color[at]) ? data.color[at] : null);
          textRow.push(
            `${escapedGenes[gene]} in ${escapedGroups[group]}<br>`
            + `mean ${data.mean[at].toPrecision(3)} · ${(data.fraction[at] * 100).toFixed(1)}% expressing`
          );
        }
        z.push(row);
        text.push(textRow);
      }
      const { across, down } = axisNames(data, swap);
      return [{
        type: 'heatmap',
        z,
        x: across.map(label => escapeHtml(label)),
        y: down.map(label => escapeHtml(label)),
        text,
        hovertemplate: '%{text}<extra></extra>',
        hoverlabel: COMMON_HOVER_STYLE,
        colorscale,
        xgap: 1,
        ygap: 1,
        colorbar
      }];
    }

    const dotMax = dotMaxFraction(data.fraction);
    const largest = largestDot(data);
    const x = [];
    const y = [];
    const size = [];
    const color = [];
    const text = [];
    for (let gene = 0; gene < geneCount; gene++) {
      for (let group = 0; group < groupCount; group++) {
        const at = gene * groupCount + group;
        x.push(swap ? escapedGroups[group] : escapedGenes[gene]);
        y.push(swap ? escapedGenes[gene] : escapedGroups[group]);
        size.push(dotDiameter(data.fraction[at], dotMax, largest));
        color.push(Number.isFinite(data.color[at]) ? data.color[at] : null);
        text.push(
          `${escapedGenes[gene]} in ${escapedGroups[group]} (${data.cellCounts[group].toLocaleString()} cells)<br>`
          + `mean ${data.mean[at].toPrecision(3)} · ${(data.fraction[at] * 100).toFixed(1)}% expressing`
        );
      }
    }
    const traces = [{
      type: 'scatter',
      mode: 'markers',
      x,
      y,
      text,
      hovertemplate: '%{text}<extra></extra>',
      hoverlabel: COMMON_HOVER_STYLE,
      marker: {
        size,
        sizemode: 'diameter',
        color,
        colorscale,
        showscale: true,
        line: { width: 0.5, color: theme.axisLine },
        colorbar
      },
      showlegend: false
    }];
    // The size legend: one dot per legend fraction, on its own small axes at
    // the bottom right.
    const legendFractions = LEGEND_FRACTIONS.map(step => step * dotMax);
    traces.push({
      type: 'scatter',
      mode: 'markers+text',
      xaxis: 'x2',
      yaxis: 'y2',
      x: legendFractions.map(() => 0),
      y: legendFractions.map((_, index) => index),
      text: legendFractions.map(value => `${Math.round(value * 100)}%`),
      textposition: 'middle right',
      textfont: { family: theme.fontFamily, size: 9, color: theme.text },
      marker: {
        // The legend's dots fit its rows, whatever the size of the plot's.
        size: legendFractions.map(value => Math.min(
          dotDiameter(value, dotMax, largest),
          dotDiameter(value, dotMax, legendRowPx(data))
        )),
        sizemode: 'diameter',
        color: theme.textMuted,
        line: { width: 0 }
      },
      hoverinfo: 'skip',
      cliponaxis: false,
      showlegend: false
    });
    return traces;
  },

  buildLayout(data) {
    const theme = getPlotTheme();
    const swap = data.swap === true;
    const matrix = data.layout === 'matrix';
    const dot = data.layout === 'dot';
    const layout = BasePlot.createLayout({ showLegend: false });
    const { across, down } = axisNames(data, swap);
    // Every gene and group is named: the labels shrink (to 7 px) before
    // Plotly would leave any out. The rows share the plot's height less the
    // brackets above and the gene names below.
    const pitch = Math.min(
      (data.plotHeightPx - 140) / Math.max(1, down.length),
      data.cellSizePx / 0.9
    );
    const fontFor = room => Math.min(10, Math.max(7, Math.floor((room - 4) / 1.3)));
    const tickfont = { family: theme.fontFamily, size: fontFor(pitch), color: theme.text };
    const longest = Math.max(...across.map(label => label.length));
    // A violin is drawn at numeric positions, so its axes are numeric with
    // the names as ticks; dots and cells sit on category axes.
    // Plotly thins a crowded category axis by itself; naming every category
    // as a tick keeps every name.
    const ticks = labels => (dot || matrix
      ? {
        type: 'category',
        tickmode: 'array',
        tickvals: labels.map(label => escapeHtml(label)),
        ticktext: labels.map(label => escapeHtml(label))
      }
      : {
        type: 'linear',
        tickmode: 'array',
        tickvals: labels.map((_, index) => index),
        ticktext: labels.map(label => escapeHtml(label))
      });
    layout.xaxis = {
      ...ticks(across),
      domain: [0, dot ? 0.86 : 1],
      tickangle: across.length > 6 || longest > 8 ? -90 : 0,
      automargin: true,
      showgrid: false,
      zeroline: false,
      tickfont,
      range: [-0.6, across.length - 0.4]
    };
    // Row 0 at the top.
    // The row names are drawn as annotations: Plotly leaves out tick labels
    // of a crowded axis on its own, and every row must be named.
    layout.yaxis = {
      ...ticks(down),
      showticklabels: false,
      showgrid: false,
      zeroline: false,
      range: [down.length - 0.4, -0.6]
    };
    if (dot) {
      layout.xaxis2 = {
        domain: [0.9, 1],
        anchor: 'y2',
        visible: false,
        // Room for the labels right of the dots.
        range: [-0.5, 5]
      };
      layout.yaxis2 = {
        domain: [0, LEGEND_DOMAIN],
        anchor: 'x2',
        visible: false,
        range: [-0.8, LEGEND_FRACTIONS.length - 0.2]
      };
      layout.annotations = [{
        xref: 'paper',
        yref: 'paper',
        x: 0.9,
        y: LEGEND_DOMAIN + 0.03,
        xanchor: 'left',
        yanchor: 'bottom',
        showarrow: false,
        text: 'Fraction of cells<br>expressing',
        font: { family: theme.fontFamily, size: 10, color: theme.text },
        align: 'left'
      }];
    } else {
      layout.annotations = [];
    }

    // Gene-set brackets: above the genes when they run across, beside them
    // when they run down.
    const shapes = [];
    const sets = Array.isArray(data.geneSets) ? data.geneSets : [];
    const bracketed = sets.length > 1 || (sets.length === 1 && sets[0].name.length > 0 && data.showSingleSetName === true);
    if (bracketed) {
      const line = { color: theme.textMuted, width: 1 };
      sets.forEach((set, index) => {
        const from = set.start - 0.4;
        const to = set.end - 1 + 0.4;
        const middle = (set.start + set.end - 1) / 2;
        if (!swap) {
          shapes.push(
            { type: 'line', xref: 'x', yref: 'paper', x0: from, x1: to, y0: 1.03, y1: 1.03, line },
            { type: 'line', xref: 'x', yref: 'paper', x0: from, x1: from, y0: 1.01, y1: 1.03, line },
            { type: 'line', xref: 'x', yref: 'paper', x0: to, x1: to, y0: 1.01, y1: 1.03, line }
          );
          // Neighbouring labels alternate in height, so short sets with long
          // names do not run into each other.
          layout.annotations.push({
            xref: 'x', yref: 'paper', x: middle, y: index % 2 === 0 ? 1.04 : 1.1, yanchor: 'bottom', showarrow: false,
            text: escapeHtml(set.name),
            font: { family: theme.fontFamily, size: 10, color: theme.textStrong }
          });
        } else {
          const right = dot ? 0.87 : 1.01;
          shapes.push(
            { type: 'line', xref: 'paper', yref: 'y', x0: right, x1: right, y0: from, y1: to, line },
            { type: 'line', xref: 'paper', yref: 'y', x0: right - 0.01, x1: right, y0: from, y1: from, line },
            { type: 'line', xref: 'paper', yref: 'y', x0: right - 0.01, x1: right, y0: to, y1: to, line }
          );
          layout.annotations.push({
            xref: 'paper', yref: 'y', x: right + 0.005, y: middle, xanchor: 'left', showarrow: false,
            text: escapeHtml(set.name),
            font: { family: theme.fontFamily, size: 10, color: theme.textStrong }
          });
        }
      });
    }
    layout.shapes = shapes;
    for (const [index, label] of down.entries()) {
      layout.annotations.push({
        xref: 'paper', x: 0, xanchor: 'right', xshift: -6,
        yref: 'y', y: dot || matrix ? escapeHtml(label) : index, yanchor: 'middle',
        text: escapeHtml(label), showarrow: false, font: tickfont
      });
    }
    const longestDown = Math.max(...down.map(label => label.length));
    layout.margin = {
      l: Math.ceil(longestDown * tickfont.size * 0.6) + 14,
      r: dot ? 10 : 60,
      t: bracketed && !swap ? (sets.length > 1 ? 68 : 48) : 16,
      b: 10
    };
    return layout;
  },

  async render(data, options, container, layoutEngine) {
    return PlotFactory.render({ definition: this, pageData: data, options, container, layoutEngine });
  },

  async update(figure, data, options, layoutEngine) {
    return PlotFactory.update({ definition: this, figure, pageData: data, options, layoutEngine });
  },

  /**
   * The long table: one row per group and gene.
   */
  exportCSV(data) {
    const columns = ['group', 'gene', 'gene_group', 'mean', 'fraction_expressing', 'n_cells'];
    const setOf = gene => data.geneSets.find(set => gene >= set.start && gene < set.end)?.name ?? '';
    const rows = [];
    for (let group = 0; group < data.groups.length; group++) {
      for (let gene = 0; gene < data.genes.length; gene++) {
        const at = gene * data.groups.length + group;
        rows.push({
          group: data.groups[group],
          gene: data.genes[gene],
          gene_group: setOf(gene),
          mean: data.mean[at],
          fraction_expressing: data.fraction[at],
          n_cells: data.cellCounts[group]
        });
      }
    }
    return { rows, columns, metadata: { plotType: 'dotplot', exportDate: new Date().toISOString() } };
  }
};

PlotRegistry.register(dotplotDefinition);
export default dotplotDefinition;
