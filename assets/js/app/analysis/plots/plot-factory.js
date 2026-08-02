/**
 * Plot Factory for Analysis Module
 *
 * Provides shared infrastructure for building Plotly plots,
 * eliminating ~70% of duplicated code across plot types.
 *
 * This module provides:
 * - Unified render/update pipeline
 * - Trace building helpers for common patterns
 * - Layout configuration utilities
 * - Standard CSV export formats
 * - Axis configuration for distribution plots
 *
 * Plot types can use PlotFactory methods to reduce boilerplate
 * while maintaining flexibility for custom implementations.
 */

import { BasePlot, COMMON_HOVER_STYLE, createMinimalPlotly, getPlotlyConfig } from './plot-base.js';
import { PlotHelpers, getPageColor, PAGE_COLORS } from '../core/plugin-contract.js';
import {
  PLOTLY_2D_SCATTER_TRACE_TYPE,
  getHeatmapTraceType,
  requireWebGL2
} from './plotly-loader.js';
import { mean, std, median } from '../shared/number-utils.js';
import { applyLegendPosition } from '../shared/legend-utils.js';
import { getPlotTheme } from '../shared/plot-theme.js';
import { escapeHtml } from '../../utils/dom-utils.js';

// Tick-label metrics, in multiples of the tick font size.
//
// Plotly measures text after it draws it; a layout has to decide how many
// labels to ask for before that. These ratios are the conservative estimate the
// fit uses: `Oswald`/system UI at the analysis tick sizes averages a little
// under 0.6em per character, and a line of tick text occupies about 1.3em.
const TICK_CHARACTER_WIDTH_RATIO = 0.58;
const TICK_LINE_HEIGHT_RATIO = 1.3;
const TICK_LABEL_GAP = 6;

// The fewest labels a thinned categorical axis is drawn with. Below two there
// is no axis left to read: one label names a single band and says nothing about
// how far the categories extend, which reads as a broken plot rather than as a
// crowded one. See `fitCategoricalTickLabels` for why two always have room.
const MIN_ANCHORED_TICK_LABELS = 2;

// =============================================================================
// PLOT REGISTRY
// =============================================================================

export { PlotRegistry } from '../shared/plot-registry-utils.js';

// =============================================================================
// CORE PLOT FACTORY
// =============================================================================

/**
 * PlotFactory - Shared plot rendering infrastructure
 *
 * Eliminates duplicated code across plot types by providing:
 * 1. Standard render/update pipelines
 * 2. Trace building helpers
 * 3. Layout configuration utilities
 * 4. CSV export templates
 */
export class PlotFactory {

  // ===========================================================================
  // RENDER PIPELINE
  // ===========================================================================

  /**
   * Standard render pipeline for all plot types
   *
   * Usage:
   * ```
   * async render(pageData, options, container, layoutEngine) {
   *   return PlotFactory.render({
   *     definition: this,
   *     pageData, options, container, layoutEngine
   *   });
   * }
   * ```
   *
   * @param {Object} config - Render configuration
   * @param {Object} config.definition - Plot definition with buildTraces/buildLayout
   * @param {Object[]} config.pageData - Page data array
   * @param {Object} config.options - Plot options
   * @param {HTMLElement} config.container - Container element
   * @param {Object} [config.layoutEngine] - Layout engine instance
   * @returns {Promise<Object>} Plotly figure reference
   */
  static async render({ definition, pageData, options, container, layoutEngine }) {
    const traces = definition.buildTraces(pageData, options, layoutEngine);
    const layout = PlotFactory.layoutForTraces(definition, traces, pageData, options, layoutEngine);
    PlotFactory.fitCategoricalTickLabels(layout, traces, container);
    applyLegendPosition(layout, options?.legendPosition);
    const config = getPlotlyConfig();

    try {
      const Plotly = await createMinimalPlotly();
      return await Plotly.newPlot(container, traces, layout, config);
    } catch (err) {
      console.error(`[${definition.id}] Render error:`, err);
      throw new Error(`Failed to render ${definition.name}: ${err.message}`);
    }
  }

  /**
   * Standard update pipeline
   *
   * @param {Object} config - Update configuration
   * @param {Object} config.definition - Plot definition
   * @param {Object} config.figure - Existing Plotly figure
   * @param {Object[]} config.pageData - Page data array
   * @param {Object} config.options - Plot options
   * @param {Object} [config.layoutEngine] - Layout engine instance
   * @returns {Promise<Object>} Updated Plotly figure
  */
  static async update({ definition, figure, pageData, options, layoutEngine }) {
    const traces = definition.buildTraces(pageData, options, layoutEngine);
    const layout = PlotFactory.layoutForTraces(definition, traces, pageData, options, layoutEngine);
    PlotFactory.fitCategoricalTickLabels(layout, traces, figure);
    applyLegendPosition(layout, options?.legendPosition);
    const Plotly = await createMinimalPlotly();
    const config = getPlotlyConfig();

    // Plotly.react can render blank when switching trace types (notably between
    // WebGL and non-WebGL heatmaps). Select a clean render before execution when
    // the trace types differ.
    const existingTraces = Array.isArray(figure?.data) ? figure.data : null;
    const nextTraces = Array.isArray(traces) ? traces : null;

    let mustFullRender = false;
    if (existingTraces && nextTraces) {
      const n = Math.min(existingTraces.length, nextTraces.length);
      for (let i = 0; i < n; i++) {
        const prevType = existingTraces[i]?.type;
        const nextType = nextTraces[i]?.type;
        if (prevType && nextType && prevType !== nextType) {
          mustFullRender = true;
          break;
        }
      }
    }

    if (mustFullRender) {
      if (typeof Plotly.purge !== 'function') {
        throw new Error('Plotly.purge is required when the trace type changes');
      }
      Plotly.purge(figure);
      return Plotly.newPlot(figure, traces, layout, config);
    }

    return Plotly.react(figure, traces, layout, config);
  }

  // ===========================================================================
  // TICK LABEL FITTING
  // ===========================================================================

  /**
   * Thin categorical tick labels to the number the rendered box can show.
   *
   * A category axis draws every category it is given, however many there are
   * and however wide the box is. Measured through the real renderer, eighteen
   * cell-type names produced ten overlapping pairs of glyphs at 224×180 and
   * none at 720×380 — so the crowding is a property of the drawn box, and it is
   * a defect rather than a limit, because a box that cannot show eighteen
   * labels can still show six of them legibly. Rotation does not solve it:
   * `tickangle: -45` changes the direction labels collide in, not whether they
   * do.
   *
   * How many labels fit is a property of the drawn box, not of the data, so the
   * decision belongs here — in the pipeline that holds the sized container —
   * rather than in `buildLayout`, which never sees it. Labels are dropped, never
   * rewritten, so the ones that remain still name real categories; the first and
   * the last are always kept so the axis stays anchored at both ends.
   *
   * Anchoring both ends outranks the capacity when the two disagree, which they
   * do at the narrow end of the range. The published pancreas datasets reach it:
   * `cell_type` holds eight categories, one short of the rotation threshold in
   * `configureCategoricalAxes`, so the axis is upright, and `Pre-endocrine`
   * needs a slot of about 89px against the 149px the sidebar leaves — a capacity
   * of one, which cannot anchor two ends. Two is drawn instead, and the geometry
   * is why that is free rather than a compromise: the capacity tiles slots of
   * the widest label across the whole axis, while the thinner draws at category
   * positions, so a pair at the ends of an eight-band axis sits (7/8) of the box
   * apart — 130px there, against the 41px `Ductal` and `Epsilon` need to clear
   * each other. Only a box narrower than one label can still collide, and that
   * box has no readable outcome to choose between.
   *
   * A container without a measurable box (a test double, or a host not yet in
   * the document) leaves the layout exactly as the plot type built it.
   *
   * @param {Object} layout - Plotly layout, mutated in place.
   * @param {Object[]} traces - The traces about to be drawn.
   * @param {HTMLElement} container - The sized host Plotly will draw into.
   * @returns {Object} The same layout reference.
   */
  static fitCategoricalTickLabels(layout, traces, container) {
    const width = container?.clientWidth;
    const height = container?.clientHeight;
    if (
      !Number.isFinite(width) || width <= 0 ||
      !Number.isFinite(height) || height <= 0 ||
      layout === null || typeof layout !== 'object' ||
      !Array.isArray(traces)
    ) {
      return layout;
    }

    const theme = getPlotTheme();
    const margin = (layout.margin !== null && typeof layout.margin === 'object')
      ? layout.margin
      : {};
    const marginOf = key => (
      Number.isFinite(margin[key]) ? margin[key] : 0
    );

    for (const [axisKey, coordinate] of [['xaxis', 'x'], ['yaxis', 'y']]) {
      const axis = layout[axisKey];
      if (axis === null || typeof axis !== 'object') continue;
      if (axis.visible === false || axis.showticklabels === false) continue;

      const ticks = PlotFactory.categoricalAxisTicks(traces, coordinate, axis);
      if (ticks === null) continue;
      const labels = ticks.values;

      const fontSize = Number.isFinite(axis.tickfont?.size)
        ? axis.tickfont.size
        : theme.tickFontSize;
      const capacity = axisKey === 'xaxis'
        ? PlotFactory.horizontalTickCapacity({
          available: width - marginOf('l') - marginOf('r'),
          labels,
          fontSize,
          tickangle: axis.tickangle
        })
        : PlotFactory.verticalTickCapacity({
          available: height - marginOf('t') - marginOf('b'),
          fontSize
        });

      const drawn = Math.max(MIN_ANCHORED_TICK_LABELS, capacity);
      if (labels.length <= drawn) continue;

      const kept = PlotFactory.spreadTickIndices(labels.length, drawn);
      axis.tickmode = 'array';
      // `tickvals` addresses category coordinates and must stay exactly the
      // strings the trace publishes; `ticktext` is what is drawn, and an axis
      // that already shortened its own labels keeps those shortened forms. Both
      // arrays are thinned by the same indices so they cannot fall out of step.
      axis.tickvals = kept.map(index => ticks.values[index]);
      axis.ticktext = kept.map(index => ticks.text[index]);
    }

    return layout;
  }

  /**
   * The category coordinates an axis will draw, with the text drawn for each.
   *
   * Bar and heatmap traces publish one entry per category; box and violin
   * traces publish one per observation, so repeats are collapsed. An axis that
   * already selected its own ticks is answered with that selection — values and
   * displayed text both — so a label it deliberately shortened stays shortened
   * when this thins the selection further.
   *
   * @param {Object[]} traces
   * @param {'x'|'y'} coordinate
   * @param {Object} axis
   * @returns {{values: string[], text: string[]}|null} Null when not categorical.
   */
  static categoricalAxisTicks(traces, coordinate, axis) {
    if (axis.tickmode === 'array') {
      const values = axis.tickvals;
      const text = axis.ticktext;
      if (
        !Array.isArray(values) ||
        !values.every(value => typeof value === 'string') ||
        !Array.isArray(text) ||
        text.length !== values.length
      ) {
        return null;
      }
      return { values, text };
    }

    let best = null;
    for (const trace of traces) {
      const values = trace?.[coordinate];
      if (!Array.isArray(values) || values.length === 0) continue;
      if (!values.every(value => typeof value === 'string')) continue;
      const distinct = [...new Set(values)];
      if (best === null || distinct.length > best.length) best = distinct;
    }
    return best === null ? null : { values: best, text: best };
  }

  /**
   * How many labels fit along a horizontal axis.
   *
   * Upright labels need their own width plus a gap. Rotated ones need enough
   * spacing that the perpendicular distance between neighbours clears a line of
   * text — `spacing × sin(angle)` — which is why rotating buys room but does not
   * make the axis unbounded.
   *
   * @param {{available: number, labels: string[], fontSize: number, tickangle: number|undefined}} config
   * @returns {number} At least one.
   */
  static horizontalTickCapacity({ available, labels, fontSize, tickangle }) {
    const characterWidth = fontSize * TICK_CHARACTER_WIDTH_RATIO;
    const lineHeight = fontSize * TICK_LINE_HEIGHT_RATIO;
    const angle = Number.isFinite(tickangle) ? Math.abs(tickangle) % 180 : 0;
    const spacing = angle === 0
      ? (Math.max(...labels.map(label => label.length)) * characterWidth) +
        TICK_LABEL_GAP
      : (lineHeight / Math.sin(angle * Math.PI / 180)) + TICK_LABEL_GAP;
    return Math.max(1, Math.floor(available / spacing));
  }

  /**
   * How many labels fit down a vertical axis. Vertical tick text is upright, so
   * one line of text plus a gap is the whole budget.
   *
   * @param {{available: number, fontSize: number}} config
   * @returns {number} At least one.
   */
  static verticalTickCapacity({ available, fontSize }) {
    const spacing = (fontSize * TICK_LINE_HEIGHT_RATIO) + TICK_LABEL_GAP;
    return Math.max(1, Math.floor(available / spacing));
  }

  /**
   * `count` indices spread evenly across `length`, first and last included.
   *
   * Stepping from zero would leave the far end of the axis unlabelled, and
   * appending the last index to a stepped run puts two labels next to each
   * other at exactly the spacing the step was chosen to avoid.
   *
   * A request for a single index cannot include both ends, so it answers with
   * the first and nothing else. `fitCategoricalTickLabels` never asks for fewer
   * than `MIN_ANCHORED_TICK_LABELS`, exactly so that an axis is never left with
   * one end named and the other silent.
   *
   * @param {number} length
   * @param {number} count
   * @returns {number[]}
   */
  static spreadTickIndices(length, count) {
    if (count <= 1) return [0];
    if (count >= length) return Array.from({ length }, (_, index) => index);
    const indices = [];
    for (let i = 0; i < count; i++) {
      indices.push(Math.round((i * (length - 1)) / (count - 1)));
    }
    return [...new Set(indices)];
  }

  /**
   * The layout a set of traces should be drawn with.
   *
   * Degenerate input - a page with no finite values, or fewer points than the
   * plot needs (a violin needs two) - makes every trace builder return null.
   * Drawing the normal layout then leaves bare axes around nothing, which reads
   * as a broken plot rather than as "there is nothing to show". Say so instead.
   *
   * @param {Object} definition
   * @param {Object[]} traces
   * @param {Object[]} pageData
   * @param {Object} options
   * @param {Object} [layoutEngine]
   * @returns {Object} Plotly layout object
   */
  static layoutForTraces(definition, traces, pageData, options, layoutEngine) {
    if (Array.isArray(traces) && traces.length === 0) {
      return PlotFactory.createEmptyStateLayout('No values to plot');
    }
    return definition.buildLayout(pageData, options, layoutEngine);
  }

  // ===========================================================================
  // TRACE BUILDING HELPERS
  // ===========================================================================

  /**
   * Create traces array by iterating over pageData with standard processing
   *
   * This is the most common pattern - loop over pages, get color and filtered values,
   * then call a trace builder function.
   *
   * @param {Object} config - Configuration
   * @param {Object[]} config.pageData - Page data array
   * @param {Object} config.options - Plot options
   * @param {Object} config.layoutEngine - Layout engine instance
   * @param {Function} config.traceBuilder - (pd, color, index, options) => trace object or null
   * @param {boolean} [config.filterNumeric=true] - Whether to pre-filter numeric values
   * @param {number} [config.minValues=0] - Minimum values required (0 = allow empty)
   * @returns {Object[]} Array of Plotly trace objects
   */
  static createTraces({ pageData, options, layoutEngine, traceBuilder, filterNumeric = false, minValues = 0 }) {
    const traces = [];

    for (let i = 0; i < pageData.length; i++) {
      const pd = pageData[i];
      const color = BasePlot.getPageColor(layoutEngine, pd.pageId, i);

      // Optionally pre-filter to numeric values
      let values = pd.values;
      if (filterNumeric) {
        values = BasePlot.filterNumeric(pd.values);
        if (values.length < minValues) continue;
      }

      // Call the custom trace builder
      const trace = traceBuilder(
        { ...pd, values },
        color,
        i,
        options
      );

      if (trace) {
        // Handle trace or array of traces
        if (Array.isArray(trace)) {
          traces.push(...trace);
        } else {
          traces.push(trace);
        }
      }
    }

    return traces;
  }

  /**
   * Build a distribution trace (boxplot, violin) with common options
   *
   * @param {Object} config - Configuration
   * @param {string} config.type - Plotly trace type ('box', 'violin')
   * @param {Object} config.pd - Page data
   * @param {string} config.color - Page color
   * @param {Object} config.options - Plot options
   * @returns {Object|null} Plotly trace object or null if empty
   */
  static buildDistributionTrace({ type, pd, color, options }) {
    const {
      orientation = 'vertical',
      showPoints = 'outliers',
      jitter = 30,
      markerSize = 4,
      showGrid = true
    } = options;

    const numericValues = BasePlot.filterNumeric(pd.values);
    if (numericValues.length === 0) return null;

    const isVertical = orientation === 'vertical';
    const jitterValue = showPoints === 'all' ? jitter / 100 : 0;

    // Page names are user/session supplied. Plotly parses its HTML subset in the
    // legend name and in category axis tick labels, so escape before display.
    const safePageName = escapeHtml(pd.pageName);

    const trace = {
      type,
      name: safePageName,
      [isVertical ? 'y' : 'x']: numericValues,
      [isVertical ? 'x' : 'y']: new Array(numericValues.length).fill(safePageName),
      marker: {
        color,
        size: markerSize,
        opacity: 0.8,
        line: { width: 0 }
      },
      line: { color, width: 2 },
      fillcolor: color + '25',
      hoverinfo: 'y+name',
      hoverlabel: COMMON_HOVER_STYLE
    };

    if (!isVertical) {
      trace.orientation = 'h';
    }

    // Box-specific options
    if (type === 'box') {
      trace.boxpoints = showPoints === 'none' ? false : showPoints;
      trace.jitter = jitterValue;
      trace.pointpos = 0;
      trace.notched = options.notched || false;
      trace.boxmean = options.showMean ? 'sd' : false;
      trace.width = (options.boxWidth || 60) / 100;
    }

    // Violin-specific options
    if (type === 'violin') {
      trace.points = showPoints === 'none' ? false : showPoints;
      trace.jitter = showPoints === 'all' ? 0.1 : 0;
      trace.pointpos = 0;
      trace.side = options.side || 'both';
      trace.spanmode = 'soft';
      trace.meanline = { visible: options.showMeanLine || false };
      trace.box = { visible: options.showBox !== false };
      trace.scalemode = 'count';
      trace.width = (options.violinWidth || 80) / 100;
      trace.fillcolor = color + '60';
    }

    return trace;
  }

  // ===========================================================================
  // CARTESIAN TRACE BUILDERS
  // ===========================================================================

  /**
   * Create a cross-browser SVG scatter trace.
   *
   * @param {Object} config - Trace configuration
   * @param {string} config.name - Trace name
   * @param {number[]} config.x - X values
   * @param {number[]} config.y - Y values
   * @param {string} [config.mode='markers'] - Trace mode ('markers', 'lines', 'markers+lines')
   * @param {string} config.color - Marker/line color
   * @param {number} [config.size=5] - Marker size
   * @param {number} [config.opacity=0.6] - Marker opacity
   * @param {string} [config.hovertemplate] - Hover text template
   * @param {boolean} [config.showlegend=true] - Show in legend
   * @param {any[]} [config.customdata] - Custom data for hover
   * @param {Object} [config.line] - Line configuration for 'lines' mode
   * @returns {Object} Plotly scatter trace object
   */
  static createScatterTrace({
    name,
    x,
    y,
    mode = 'markers',
    color,
    size = 5,
    opacity = 0.6,
    hovertemplate,
    showlegend = true,
    customdata,
    line,
    text
  }) {
    const trace = {
      type: PLOTLY_2D_SCATTER_TRACE_TYPE,
      mode,
      name,
      x,
      y,
      showlegend,
      hoverlabel: COMMON_HOVER_STYLE
    };

    // Add marker config for modes with markers
    if (mode.includes('markers')) {
      trace.marker = {
        color,
        size,
        opacity,
        line: { width: 0 }
      };
    }

    // Add line config for modes with lines
    if (mode.includes('lines')) {
      trace.line = line || {
        color,
        width: 2
      };
    }

    if (hovertemplate) {
      trace.hovertemplate = hovertemplate;
    }

    if (customdata) {
      trace.customdata = customdata;
    }

    if (text) {
      trace.text = text;
    }

    return trace;
  }

  /**
   * Create a heatmap trace (prefers WebGL when available).
   *
   * Note: `heatmapgl` does not support some annotation features across
   * Plotly builds, so when `texttemplate` is provided we force the
   * non-WebGL `heatmap` trace for correctness.
   *
   * @param {Object} config - Trace configuration
   * @param {number[][]} config.z - Matrix data
   * @param {string[]} [config.x] - X axis labels
   * @param {string[]} [config.y] - Y axis labels
   * @param {string} [config.colorscale='Blues'] - Plotly colorscale
   * @param {boolean} [config.showscale=true] - Show colorbar
   * @param {string[][]} [config.text] - Text matrix for hover/annotation
   * @param {string} [config.hovertemplate] - Hover text template
   * @param {Object} [config.colorbar] - Colorbar configuration
   * @returns {Object} GPU-accelerated Plotly trace object
   */
  static createGPUHeatmapTrace({
    z,
    x,
    y,
    colorscale = 'Blues',
    showscale = true,
    text,
    hovertemplate,
    colorbar,
    texttemplate,
    textfont
  }) {
    const wantsTextAnnotations = !!texttemplate;

    const trace = {
      type: wantsTextAnnotations ? 'heatmap' : getHeatmapTraceType(),
      z,
      colorscale,
      showscale,
      hoverlabel: COMMON_HOVER_STYLE
    };

    if (x) trace.x = x;
    if (y) trace.y = y;
    if (text) trace.text = text;
    if (hovertemplate) trace.hovertemplate = hovertemplate;
    if (colorbar) trace.colorbar = colorbar;
    if (texttemplate) trace.texttemplate = texttemplate;
    if (textfont) trace.textfont = textfont;

    return trace;
  }

  // ===========================================================================
  // LAYOUT CONFIGURATION
  // ===========================================================================

  /**
   * Create base layout with common configuration
   *
   * @param {Object} config - Layout configuration
   * @param {Object[]} config.pageData - Page data array
   * @param {Object} config.options - Plot options
   * @param {Object} [config.custom] - Custom layout properties
   * @returns {Object} Plotly layout object
   */
  static createLayout({ pageData, options, custom = {} }) {
    const layout = BasePlot.createLayout({
      showLegend: (options.showLegend ?? true) && pageData.length > 1,
      ...custom
    });

    return layout;
  }

  /**
   * Configure axes for distribution plots (boxplot, violin, histogram)
   *
   * @param {Object} layout - Plotly layout object (mutated)
   * @param {Object} config - Configuration
   * @param {Object[]} config.pageData - Page data array
   * @param {Object} config.options - Plot options
   * @param {string} [config.valueAxisLabel] - Label for value axis (default from pageData)
   * @returns {Object} Modified layout object
   */
  static configureDistributionAxes(layout, { pageData, options, valueAxisLabel }) {
    const {
      orientation = 'vertical',
      logScale = false,
      showGrid = true
    } = options;

    const variableName = valueAxisLabel === undefined
      ? BasePlot.getVariableName(pageData)
      : valueAxisLabel;
    if (typeof variableName !== 'string' || variableName.length === 0) {
      throw new TypeError('Distribution axis label must be a non-empty string');
    }
    const theme = getPlotTheme();
    const gridColor = showGrid ? theme.grid : 'transparent';
    const isVertical = orientation === 'vertical';
    // Axis titles are parsed for Plotly's HTML subset; the variable name is an
    // obs/var field name from the dataset, so escape it before display.
    const safeVariableName = escapeHtml(variableName);

    if (isVertical) {
      layout.xaxis = {
        title: '',
        automargin: true,
        showgrid: false
      };
      layout.yaxis = {
        title: safeVariableName,
        zeroline: false,
        type: logScale ? 'log' : 'linear',
        showgrid: showGrid,
        gridcolor: gridColor
      };
    } else {
      layout.xaxis = {
        title: safeVariableName,
        zeroline: false,
        type: logScale ? 'log' : 'linear',
        showgrid: showGrid,
        gridcolor: gridColor
      };
      layout.yaxis = {
        title: '',
        automargin: true,
        showgrid: false
      };
      layout.margin = { l: 100, r: 20, t: 30, b: 50 };
    }

    return layout;
  }

  /**
   * Configure axes for histogram plots
   *
   * @param {Object} layout - Plotly layout object (mutated)
   * @param {Object} config - Configuration
   * @param {Object[]} config.pageData - Page data array
   * @param {Object} config.options - Plot options
   * @returns {Object} Modified layout object
   */
  static configureHistogramAxes(layout, { pageData, options }) {
    const { logX = false, logY = false, histnorm = '' } = options;

    // Dataset-supplied field name reaching a markup-parsing axis title.
    const variableName = escapeHtml(BasePlot.getVariableName(pageData));

    layout.xaxis = {
      title: variableName,
      automargin: true,
      type: logX ? 'log' : 'linear'
    };

    let yLabel = 'Count';
    if (histnorm === 'percent') yLabel = 'Percent';
    else if (histnorm === 'probability') yLabel = 'Probability';
    else if (histnorm === 'density') yLabel = 'Density';

    layout.yaxis = {
      title: yLabel,
      zeroline: true,
      type: logY ? 'log' : 'linear'
    };

    return layout;
  }

  /**
   * Configure axes for categorical bar plots
   *
   * @param {Object} layout - Plotly layout object (mutated)
   * @param {Object} config - Configuration
   * @param {string[]} config.categories - Category names
   * @param {Object} config.options - Plot options
   * @returns {Object} Modified layout object
   */
  static configureCategoricalAxes(layout, { categories, options }) {
    const { orientation = 'vertical', logScale = false, normalize = false } = options;
    const axisLabel = normalize ? 'Percentage (%)' : 'Count';

    if (orientation === 'vertical') {
      layout.xaxis = {
        title: '',
        tickangle: categories.length > 8 ? -45 : 0,
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
      layout.margin = { l: 100, r: 20, t: 30, b: 50 };
    }

    return layout;
  }

  // ===========================================================================
  // CSV EXPORT HELPERS
  // ===========================================================================

  /**
   * Export distribution statistics (for boxplot, violinplot)
   *
   * @param {Object[]} pageData - Page data array
   * @param {Object} [options] - Export options
   * @returns {Object} { rows, columns, metadata }
   */
  static exportDistributionCSV(pageData, options = {}) {
    const rows = [];
    const columns = ['page', 'n', 'min', 'q1', 'median', 'q3', 'max', 'mean', 'std', 'iqr'];

    for (const pd of pageData) {
      const values = BasePlot.filterNumeric(pd.values);

      if (values.length === 0) {
        rows.push({
          page: pd.pageName,
          n: 0,
          min: null, q1: null, median: null, q3: null, max: null,
          mean: null, std: null, iqr: null
        });
        continue;
      }

      // Use centralized statistics utilities
      const sorted = [...values].sort((a, b) => a - b);
      const n = sorted.length;
      const minVal = sorted[0];
      const maxVal = sorted[n - 1];
      const q1 = sorted[Math.floor(n * 0.25)];
      const q3 = sorted[Math.floor(n * 0.75)];
      const medianVal = median(values);
      const meanVal = mean(values);
      const stdVal = std(values);
      const iqr = q3 - q1;

      rows.push({
        page: pd.pageName,
        n,
        min: minVal.toFixed(4),
        q1: q1.toFixed(4),
        median: medianVal.toFixed(4),
        q3: q3.toFixed(4),
        max: maxVal.toFixed(4),
        mean: meanVal.toFixed(4),
        std: stdVal.toFixed(4),
        iqr: iqr.toFixed(4)
      });
    }

    return {
      rows,
      columns,
      metadata: {
        pageCount: pageData.length,
        variable: pageData[0]?.variableInfo?.name || 'Value',
        exportDate: new Date().toISOString(),
        ...options.metadata
      }
    };
  }

  /**
   * Export categorical counts (for barplot, pieplot)
   *
   * @param {Object[]} pageData - Page data array
   * @param {Object} [options] - Export options
   * @param {string[]} [options.categories] - Sorted category list
   * @returns {Object} { rows, columns, metadata }
   */
  static exportCategoricalCSV(pageData, options = {}) {
    let { categories } = options;

    // If categories not provided, derive from data
    if (!categories) {
      const globalCounts = new Map();
      for (const pd of pageData) {
        for (const value of pd.values) {
          globalCounts.set(value, (globalCounts.get(value) || 0) + 1);
        }
      }
      categories = PlotHelpers.sortCategories(globalCounts, options.sortBy || 'count');
    }

    const rows = [];
    const columns = ['category'];

    // Add columns for each page
    for (const pd of pageData) {
      columns.push(`${pd.pageName}_count`);
      columns.push(`${pd.pageName}_percent`);
    }

    // Build rows
    for (const category of categories) {
      const row = { category };

      for (const pd of pageData) {
        const counts = PlotHelpers.countCategories(pd.values);
        const count = counts.get(category) || 0;
        const total = pd.cellCount || pd.values.length;
        const percent = total > 0 ? (count / total * 100) : 0;

        row[`${pd.pageName}_count`] = count;
        row[`${pd.pageName}_percent`] = percent.toFixed(2);
      }

      rows.push(row);
    }

    return {
      rows,
      columns,
      metadata: {
        categoryCount: categories.length,
        pageCount: pageData.length,
        exportDate: new Date().toISOString(),
        ...options.metadata
      }
    };
  }

  /**
   * Export histogram bins
   *
   * @param {Object[]} pageData - Page data array
   * @param {Object} options - Options including nbins
   * @returns {Object} { rows, columns, metadata }
   */
  static exportHistogramCSV(pageData, options = {}) {
    const { nbins = 20 } = options;
    const { min: globalMin, max: globalMax } = BasePlot.getGlobalRange(pageData);

    if (!isFinite(globalMin) || !isFinite(globalMax)) {
      return { rows: [], columns: ['bin'], metadata: { error: 'No valid numeric data' } };
    }

    const binSize = (globalMax - globalMin) / nbins;
    const rows = [];
    const columns = ['bin_start', 'bin_end', 'bin_label'];

    // Add columns for each page
    for (const pd of pageData) {
      columns.push(`${pd.pageName}_count`);
      columns.push(`${pd.pageName}_percent`);
    }

    // Compute bins for each page
    const pageBins = new Map();
    for (const pd of pageData) {
      const bins = new Array(nbins).fill(0);
      const numericValues = BasePlot.filterNumeric(pd.values);

      for (const v of numericValues) {
        let binIdx = Math.floor((v - globalMin) / binSize);
        if (binIdx >= nbins) binIdx = nbins - 1;
        if (binIdx < 0) binIdx = 0;
        bins[binIdx]++;
      }

      pageBins.set(pd.pageName, { bins, total: numericValues.length });
    }

    // Build rows
    for (let i = 0; i < nbins; i++) {
      const binStart = globalMin + i * binSize;
      const binEnd = globalMin + (i + 1) * binSize;

      const row = {
        bin_start: binStart.toFixed(4),
        bin_end: binEnd.toFixed(4),
        bin_label: `${binStart.toFixed(2)} - ${binEnd.toFixed(2)}`
      };

      for (const pd of pageData) {
        const { bins, total } = pageBins.get(pd.pageName);
        const count = bins[i];
        const percent = total > 0 ? (count / total * 100) : 0;

        row[`${pd.pageName}_count`] = count;
        row[`${pd.pageName}_percent`] = percent.toFixed(2);
      }

      rows.push(row);
    }

    return {
      rows,
      columns,
      metadata: {
        plotType: 'histogram',
        binCount: nbins,
        binSize,
        globalMin,
        globalMax,
        pageCount: pageData.length,
        exportDate: new Date().toISOString()
      }
    };
  }

  // ===========================================================================
  // UTILITY FUNCTIONS
  // ===========================================================================

  /**
   * Get sorted categories from page data
   *
   * @param {Object[]} pageData - Page data array
   * @param {string} [sortBy='count'] - Sort method
   * @returns {string[]} Sorted category array
   */
  static getSortedCategories(pageData, sortBy = 'count') {
    const globalCounts = new Map();
    for (const pd of pageData) {
      for (const value of pd.values) {
        globalCounts.set(value, (globalCounts.get(value) || 0) + 1);
      }
    }
    return PlotHelpers.sortCategories(globalCounts, sortBy);
  }

  /**
   * Convert hex color to rgba
   *
   * @param {string} hex - Hex color string
   * @param {number} alpha - Alpha value (0-1)
   * @returns {string} RGBA color string
   */
  static hexToRgba(hex, alpha) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result) return `rgba(100,100,100,${alpha})`;
    const r = parseInt(result[1], 16);
    const g = parseInt(result[2], 16);
    const b = parseInt(result[3], 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  /**
   * Create an empty state layout
   *
   * @param {string} message - Message to display
   * @returns {Object} Layout with annotation
   */
  static createEmptyStateLayout(message) {
    const theme = getPlotTheme();
    const layout = BasePlot.createLayout({ showLegend: false });
    // Axes over no data are misread as a broken plot, and the sidebar preview
    // is only ~200px wide, so the message has to fit at the theme's own body
    // size rather than at a larger hard-coded one.
    layout.xaxis = { visible: false };
    layout.yaxis = { visible: false };
    layout.margin = { l: 8, r: 8, t: 8, b: 8 };
    layout.annotations = [{
      text: message,
      x: 0.5,
      y: 0.5,
      xref: 'paper',
      yref: 'paper',
      xanchor: 'center',
      yanchor: 'middle',
      showarrow: false,
      font: {
        family: theme.fontFamily,
        size: theme.fontSize,
        color: theme.textMuted
      }
    }];
    return layout;
  }
}

// =============================================================================
// PLOT DEFINITION FACTORY
// =============================================================================

/**
 * Create a simple distribution plot definition (boxplot, violin, histogram)
 *
 * This factory function creates a complete plot definition with minimal code.
 * Use for plots that follow the standard pageData iteration pattern.
 *
 * @param {Object} config - Plot configuration
 * @param {string} config.id - Plot type ID
 * @param {string} config.name - Display name
 * @param {string} [config.description] - Description
 * @param {Object} config.defaultOptions - Default option values
 * @param {Object} config.optionSchema - Option schema for UI
 * @param {Function} config.buildTrace - (pd, color, index, options) => trace or traces
 * @param {Function} [config.customizeLayout] - (layout, pageData, options) => layout
 * @param {string} [config.exportType='distribution'] - 'distribution', 'categorical', 'histogram', or 'custom'
 * @param {Function} [config.customExportCSV] - Custom export function
 * @returns {Object} Complete plot definition
 */
export function createDistributionPlotDefinition(config) {
  const {
    id,
    name,
    description = '',
    defaultOptions = {},
    optionSchema = {},
    buildTrace,
    customizeLayout,
    exportType = 'distribution',
    customExportCSV
  } = config;

  return {
    id,
    name,
    description,
    supportedTypes: ['continuous'],
    supportedLayouts: ['side-by-side', 'grouped', 'overlay'],
    defaultOptions,
    optionSchema,

    buildTraces(pageData, options, layoutEngine) {
      return PlotFactory.createTraces({
        pageData,
        options,
        layoutEngine,
        traceBuilder: buildTrace,
        filterNumeric: true,
        minValues: 1
      });
    },

    buildLayout(pageData, options, layoutEngine) {
      const layout = PlotFactory.createLayout({ pageData, options });
      PlotFactory.configureDistributionAxes(layout, { pageData, options });

      if (customizeLayout) {
        customizeLayout(layout, pageData, options, layoutEngine);
      }

      return layout;
    },

    async render(pageData, options, container, layoutEngine) {
      return PlotFactory.render({
        definition: this,
        pageData,
        options,
        container,
        layoutEngine
      });
    },

    async update(figure, pageData, options, layoutEngine) {
      return PlotFactory.update({
        definition: this,
        figure,
        pageData,
        options,
        layoutEngine
      });
    },

    exportCSV(pageData, options) {
      if (customExportCSV) {
        return customExportCSV(pageData, options);
      }

      switch (exportType) {
        case 'categorical':
          return PlotFactory.exportCategoricalCSV(pageData, { metadata: { plotType: id } });
        case 'histogram':
          return PlotFactory.exportHistogramCSV(pageData, { ...options, metadata: { plotType: id } });
        case 'distribution':
        default:
          return PlotFactory.exportDistributionCSV(pageData, { metadata: { plotType: id } });
      }
    }
  };
}

/**
 * Create a categorical plot definition (barplot, pieplot, heatmap)
 *
 * @param {Object} config - Plot configuration
 * @returns {Object} Complete plot definition
 */
export function createCategoricalPlotDefinition(config) {
  const {
    id,
    name,
    description = '',
    defaultOptions = {},
    optionSchema = {},
    buildTraces,
    buildLayout,
    customExportCSV
  } = config;

  return {
    id,
    name,
    description,
    supportedTypes: ['categorical'],
    supportedLayouts: ['side-by-side', 'grouped', 'stacked', 'overlay'],
    defaultOptions,
    optionSchema,

    buildTraces,
    buildLayout,

    async render(pageData, options, container, layoutEngine) {
      return PlotFactory.render({
        definition: this,
        pageData,
        options,
        container,
        layoutEngine
      });
    },

    async update(figure, pageData, options, layoutEngine) {
      return PlotFactory.update({
        definition: this,
        figure,
        pageData,
        options,
        layoutEngine
      });
    },

    exportCSV(pageData, options) {
      if (customExportCSV) {
        return customExportCSV(pageData, options);
      }
      return PlotFactory.exportCategoricalCSV(pageData, { metadata: { plotType: id } });
    }
  };
}

// =============================================================================
// EXPORTS
// =============================================================================

export default PlotFactory;

// Re-export commonly used items for convenience
export { BasePlot, COMMON_HOVER_STYLE, createMinimalPlotly, getPlotlyConfig, PlotHelpers, getPageColor, PAGE_COLORS };

// Re-export current trace contracts for centralized access.
export { PLOTLY_2D_SCATTER_TRACE_TYPE, getHeatmapTraceType, requireWebGL2 };
