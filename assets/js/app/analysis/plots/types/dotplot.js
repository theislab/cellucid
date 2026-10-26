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
 * The plot is laid out for the size it is drawn at (`viewport`): the names
 * shrink and turn to fit their rows and columns, and the colour bar and the
 * size legend stand in a column right of the plot, placed in pixels, so no
 * label lands on another at any size (`dotplotMinimumWidth`: the narrowest
 * box that names every gene and group).
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
 *   layout       'dot' | 'matrix'
 *   swap         genes down and groups across
 *
 * @module plots/types/dotplot
 */

import { PlotFactory, PlotRegistry, BasePlot, COMMON_HOVER_STYLE } from '../plot-factory.js';
import { getPlotTheme } from '../../shared/plot-theme.js';
import { escapeHtml } from '../../../utils/dom-utils.js';
import { textHeight, textWidth } from '../text-measure.js';
import { formatCountOf } from '../../../../utils/format-units.js';

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
/** The size legend's title. */
const SIZE_LEGEND_TITLE = ['Fraction of cells', 'expressing'];
/** Font sizes of the legends' titles and of their labels. */
const LEGEND_TITLE_SIZE = 10;
const LEGEND_LABEL_SIZE = 9;
/** The colour bar's thickness, and the room between the legends and what is beside them, in px. */
const COLORBAR_THICKNESS = 10;
const LEGEND_GAP = 8;
/** The colour bar's length, in px: its share of the plot's height, within these. */
const COLORBAR_LENGTH = Object.freeze({ share: 0.38, min: 30, max: 140 });
/** The smallest row of the size legend: one line of its labels, with the label's frame. */
const SIZE_ROW_MIN = Math.ceil(textHeight(1, LEGEND_LABEL_SIZE)) + 3;
/** Padding Plotly keeps around the colour bar, in px. */
const COLORBAR_XPAD = 2;
/** Gene-set names above the plot: their font, how far above it the first row stands, and the rows' pitch. */
const SET_NAME_SIZE = 10;
const SET_NAME_FIRST_ROW = 8;
const SET_NAME_ROW = Math.ceil(textHeight(1, SET_NAME_SIZE)) + 4;

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

/** A colour bar tick as Plotly writes it, near enough to size its labels: three significant digits. */
function tickText(value) {
  return Number.isFinite(value) ? String(Number(value.toPrecision(3))).replace('-', '−') : '';
}

/** The smallest names, in px: below this they would not be read. */
const SMALLEST_NAME_SIZE = 7;

function widestOf(labels, font) {
  return Math.max(0, ...labels.map(label => textWidth(label, font)));
}

/** Whether the gene sets are bracketed, and their names shown. */
function bracketsShown(data) {
  const sets = Array.isArray(data.geneSets) ? data.geneSets : [];
  return sets.length > 1 || (sets.length === 1 && sets[0].name.length > 0 && data.showSingleSetName === true);
}

/**
 * The names of the genes and groups at the size the plot is drawn at: the
 * largest font, from 10 px down to 7, at which each row holds its name and
 * each column its name (across, or turned to run down when they would not
 * fit across).
 */
function namesFor(data, viewport, rightMargin, top) {
  const theme = getPlotTheme();
  const { across, down } = axisNames(data, data.swap === true);
  const longest = Math.max(...across.map(label => label.length));
  for (let size = 10; size >= SMALLEST_NAME_SIZE; size--) {
    const tickfont = { family: theme.fontFamily, size, color: theme.text };
    const left = Math.ceil(widestOf(down, tickfont)) + 14;
    const columns = (viewport.width - left - rightMargin) / Math.max(1, across.length);
    const line = textHeight(1, size);
    // As before, many or long gene names run down; any that do not fit across do too.
    const upright = across.length <= 6 && longest <= 8 && widestOf(across, tickfont) + 4 <= columns;
    const bottom = Math.ceil(upright ? line : widestOf(across, tickfont)) + 10;
    const rows = (viewport.height - top - bottom) / Math.max(1, down.length);
    const fits = rows >= line && (upright || columns >= line);
    if (fits || size === SMALLEST_NAME_SIZE) {
      return { tickfont, tickangle: upright ? 0 : -90, margin: { l: left, t: top, b: bottom } };
    }
  }
  throw new RangeError('Dot plot name sizes must include the smallest size.');
}

/**
 * The narrowest box, in px, at which the dot plot names every gene and
 * group without one name on another: the smallest names, turned to run
 * down, one line per column.
 *
 * @param {Object} data - The plot data
 * @param {number} height - The height it will be drawn at
 */
export function dotplotMinimumWidth(data, height) {
  const theme = getPlotTheme();
  const { across, down } = axisNames(data, data.swap === true);
  const tickfont = { family: theme.fontFamily, size: SMALLEST_NAME_SIZE };
  const right = frameOf(data, { width: Number.MAX_SAFE_INTEGER, height }).margin.r;
  return Math.ceil(widestOf(down, tickfont) + 14 + across.length * (textHeight(1, SMALLEST_NAME_SIZE) + 1) + right);
}

/**
 * The plot's frame in px at the size it is drawn at: the margins, the
 * names, and the column right of the plot where the colour bar and the size
 * legend stand one under the other. Everything beside the plot is placed in
 * px from here, so no legend lands on a label, or on the other legend, at
 * any size.
 *
 * @param {Object} data
 * @param {{width: number, height: number}} viewport
 * @returns {{margin: Object, tickfont: Object, tickangle: number, plotHeight: number,
 *   brackets: {width: number}|null, colorbar: Object, sizeLegend: Object|null}}
 */
function frameOf(data, viewport) {
  if (!(viewport?.width > 0) || !(viewport?.height > 0)) {
    throw new RangeError('A dot plot is laid out for a box of positive size.');
  }
  const theme = getPlotTheme();
  const swap = data.swap === true;
  const dot = data.layout === 'dot';
  const sets = Array.isArray(data.geneSets) ? data.geneSets : [];
  const bracketed = bracketsShown(data);
  const margin = { l: 0, t: 0, b: 0, r: 0 };
  const { across, down } = axisNames(data, swap);
  const setFont = { family: theme.fontFamily, size: SET_NAME_SIZE };
  const labelFont = { family: theme.fontFamily, size: LEGEND_LABEL_SIZE };
  const titleFont = { family: theme.fontFamily, size: LEGEND_TITLE_SIZE };
  // Genes running down are bracketed right of the plot, before the legends.
  const brackets = bracketed && swap
    ? { width: Math.ceil(10 + widestOf(sets.map(set => set.name), setFont)) + LEGEND_GAP }
    : null;
  const start = (brackets?.width ?? 0) + LEGEND_GAP;
  let low = Infinity;
  let high = -Infinity;
  for (const value of data.color) {
    if (!Number.isFinite(value)) continue;
    if (value < low) low = value;
    if (value > high) high = value;
  }
  const barWidth = COLORBAR_THICKNESS + 4 + widestOf([tickText(low), tickText(high)], labelFont) + 6
    + Math.ceil(textHeight(1, LEGEND_TITLE_SIZE)) + 2;
  // The column's widest: the size legend's dots as large as the plot's.
  const widestColumn = Math.max(
    barWidth,
    widestOf(SIZE_LEGEND_TITLE, titleFont),
    largestDot(data) + 4 + widestOf(['100%'], labelFont)
  );
  // Gene-set names above the plot, each in the lowest row where it clears
  // the names beside it, at the narrowest the plot can be.
  const setRows = [];
  let top = 16;
  if (bracketed && !swap) {
    const narrowest = viewport.width
      - (Math.ceil(widestOf(down, { family: theme.fontFamily, size: 10 })) + 14)
      - (start + widestColumn + 4);
    const column = narrowest / Math.max(1, across.length);
    const rowEnds = [];
    for (const set of sets) {
      const middle = ((set.start + set.end - 1) / 2 + 0.6) * column;
      const half = textWidth(set.name, setFont) / 2 + 4;
      let row = 0;
      while (row < rowEnds.length && rowEnds[row] > middle - half) row++;
      rowEnds[row] = middle + half;
      setRows.push(row);
    }
    top = Math.max(sets.length > 1 ? 68 : 48, SET_NAME_FIRST_ROW + rowEnds.length * SET_NAME_ROW + 6);
  }
  // The bottom margin the names need, for the legends' room: as for the
  // largest names, which need the most.
  const tallest = namesFor(data, { width: Number.MAX_SAFE_INTEGER, height: viewport.height }, 0, top);
  const plotHeight = viewport.height - top - tallest.margin.b;
  // Below the plot area the column may run on into the bottom margin, which
  // holds nothing right of the plot.
  const room = plotHeight + tallest.margin.b - 2;
  let barLength = Math.max(COLORBAR_LENGTH.min, Math.min(COLORBAR_LENGTH.max, Math.round(plotHeight * COLORBAR_LENGTH.share)));
  let sizeLegend = null;
  let columnWidth = barWidth;
  if (dot) {
    const dotMax = dotMaxFraction(data.fraction);
    const titleHeight = Math.ceil(textHeight(SIZE_LEGEND_TITLE.length, LEGEND_TITLE_SIZE));
    const fixed = () => barLength + LEGEND_GAP + titleHeight + 4;
    // Each row holds its dot, as large as the plot's largest, if there is room.
    let row = Math.max(SIZE_ROW_MIN, Math.ceil(largestDot(data)) + 3);
    if (fixed() + LEGEND_FRACTIONS.length * row > room) {
      row = Math.max(SIZE_ROW_MIN, Math.floor((room - fixed()) / LEGEND_FRACTIONS.length));
    }
    if (fixed() + LEGEND_FRACTIONS.length * row > room) {
      barLength = Math.max(COLORBAR_LENGTH.min, room - LEGEND_FRACTIONS.length * row - (fixed() - barLength));
    }
    const largestShown = Math.min(largestDot(data), row - 3);
    const fractions = LEGEND_FRACTIONS.map(step => step * dotMax);
    const labels = fractions.map(value => `${Math.round(value * 100)}%`);
    sizeLegend = {
      top: barLength + LEGEND_GAP,
      titleHeight,
      row,
      largest: largestShown,
      diameters: fractions.map(value => dotDiameter(value, dotMax, largestShown)),
      labels
    };
    columnWidth = Math.max(
      barWidth,
      widestOf(SIZE_LEGEND_TITLE, titleFont),
      largestShown + 4 + widestOf(labels, labelFont)
    );
  }
  margin.r = Math.ceil(start + columnWidth) + 4;
  const names = namesFor(data, viewport, margin.r, top);
  Object.assign(margin, names.margin);
  const plotWidth = viewport.width - margin.l - margin.r;
  return {
    margin,
    tickfont: names.tickfont,
    tickangle: names.tickangle,
    plotHeight,
    brackets,
    setRows,
    // The bar stands `start` px right of the plot: Plotly places it in
    // fractions of the plot's width.
    colorbar: { start, length: barLength, x: 1 + (start - COLORBAR_XPAD) / plotWidth },
    sizeLegend
  };
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

  buildTraces(data, _options, _layoutEngine, viewport) {
    const theme = getPlotTheme();
    const swap = data.swap === true;
    const matrix = data.layout === 'matrix';
    const geneCount = data.genes.length;
    const groupCount = data.groups.length;
    if (geneCount === 0 || groupCount === 0) return [];
    const escapedGenes = data.genes.map(gene => escapeHtml(gene));
    const escapedGroups = data.groups.map(group => escapeHtml(group));
    const colorscale = DOTPLOT_COLOR_MAPS[data.colorMap];
    // The colour bar heads the column right of the plot (`frameOf`).
    const { colorbar: bar } = frameOf(data, viewport);
    const colorbar = {
      thicknessmode: 'pixels',
      thickness: COLORBAR_THICKNESS,
      lenmode: 'pixels',
      len: bar.length,
      y: 1,
      yanchor: 'top',
      ypad: 0,
      x: bar.x,
      xanchor: 'left',
      xpad: COLORBAR_XPAD,
      outlinewidth: 0,
      tickfont: { family: theme.fontFamily, size: LEGEND_LABEL_SIZE, color: theme.textMuted },
      title: {
        text: escapeHtml(data.colorLabel),
        side: 'right',
        font: { family: theme.fontFamily, size: LEGEND_TITLE_SIZE, color: theme.text }
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
          `${escapedGenes[gene]} in ${escapedGroups[group]} (${formatCountOf(data.cellCounts[group], 'cell')})<br>`
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
    return traces;
  },

  buildLayout(data, _options, _layoutEngine, viewport) {
    const theme = getPlotTheme();
    const swap = data.swap === true;
    const matrix = data.layout === 'matrix';
    const dot = data.layout === 'dot';
    const layout = BasePlot.createLayout({ showLegend: false });
    const { across, down } = axisNames(data, swap);
    const frame = frameOf(data, viewport);
    const { tickfont } = frame;
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
    // The margins are the labels' own (`frameOf`): the legends right of the
    // plot are placed from them.
    layout.xaxis = {
      ...ticks(across),
      domain: [0, 1],
      tickangle: frame.tickangle,
      automargin: false,
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
    layout.annotations = [];
    const shapes = [];
    // The size legend, under the colour bar: its title, then one dot per
    // fraction with its label, each row in px from the plot's top.
    const legend = frame.sizeLegend;
    if (legend !== null) {
      const left = frame.colorbar.start;
      layout.annotations.push({
        xref: 'paper', yref: 'paper', x: 1, y: 1, xanchor: 'left', yanchor: 'top',
        xshift: left, yshift: -legend.top,
        showarrow: false,
        text: SIZE_LEGEND_TITLE.join('<br>'),
        font: { family: theme.fontFamily, size: LEGEND_TITLE_SIZE, color: theme.text },
        align: 'left'
      });
      legend.diameters.forEach((diameter, index) => {
        const middle = legend.top + legend.titleHeight + 4 + (index + 0.5) * legend.row;
        const centre = left + legend.largest / 2;
        shapes.push({
          type: 'circle', xref: 'paper', yref: 'paper', xsizemode: 'pixel', ysizemode: 'pixel',
          xanchor: 1, yanchor: 1,
          x0: centre - diameter / 2, x1: centre + diameter / 2,
          y0: -middle - diameter / 2, y1: -middle + diameter / 2,
          fillcolor: theme.textMuted, line: { width: 0 }
        });
        layout.annotations.push({
          xref: 'paper', yref: 'paper', x: 1, y: 1, xanchor: 'left', yanchor: 'middle',
          xshift: left + legend.largest + 4, yshift: -middle,
          showarrow: false,
          text: legend.labels[index],
          font: { family: theme.fontFamily, size: LEGEND_LABEL_SIZE, color: theme.text }
        });
      });
    }

    // Gene-set brackets: above the genes when they run across, beside them
    // when they run down, in px from the plot's edge.
    const sets = Array.isArray(data.geneSets) ? data.geneSets : [];
    const bracketed = sets.length > 1 || (sets.length === 1 && sets[0].name.length > 0 && data.showSingleSetName === true);
    if (bracketed) {
      const line = { color: theme.textMuted, width: 1 };
      sets.forEach((set, index) => {
        const from = set.start - 0.4;
        const to = set.end - 1 + 0.4;
        const middle = (set.start + set.end - 1) / 2;
        if (!swap) {
          const above = { yref: 'paper', ysizemode: 'pixel', yanchor: 1 };
          shapes.push(
            { type: 'line', xref: 'x', ...above, x0: from, x1: to, y0: 6, y1: 6, line },
            { type: 'line', xref: 'x', ...above, x0: from, x1: from, y0: 2, y1: 6, line },
            { type: 'line', xref: 'x', ...above, x0: to, x1: to, y0: 2, y1: 6, line }
          );
          // A name that would run into the one beside it stands a row higher.
          layout.annotations.push({
            xref: 'x', yref: 'paper', x: middle, y: 1, yshift: SET_NAME_FIRST_ROW + frame.setRows[index] * SET_NAME_ROW, yanchor: 'bottom', showarrow: false,
            text: escapeHtml(set.name),
            font: { family: theme.fontFamily, size: 10, color: theme.textStrong }
          });
        } else {
          const beside = { xref: 'paper', xsizemode: 'pixel', xanchor: 1 };
          shapes.push(
            { type: 'line', ...beside, yref: 'y', x0: 6, x1: 6, y0: from, y1: to, line },
            { type: 'line', ...beside, yref: 'y', x0: 2, x1: 6, y0: from, y1: from, line },
            { type: 'line', ...beside, yref: 'y', x0: 2, x1: 6, y0: to, y1: to, line }
          );
          layout.annotations.push({
            xref: 'paper', yref: 'y', x: 1, xshift: 10, y: middle, xanchor: 'left', showarrow: false,
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
    layout.margin = { ...frame.margin };
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
