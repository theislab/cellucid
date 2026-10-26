/**
 * Box Plot for Page Analysis
 *
 * Displays distribution of continuous values across pages using box-and-whisker plots.
 * Refactored to use PlotFactory for reduced code duplication.
 */

import { PlotFactory, PlotRegistry } from '../plot-factory.js';
import { adoptFiniteNumbers } from '../../shared/number-utils.js';
import { getComputeManager } from '../../compute/compute-manager.js';
import { OperationType } from '../../compute/operations.js';

/**
 * Finite values from which a page's box statistics are computed by an
 * analysis worker. They need every value in ascending order — a linear-time
 * sort, still 30 ms of main-thread work for a million values and ten times
 * that for ten million; below this the hand-off costs more than it saves.
 */
const WORKER_MIN_VALUES = 100_000;

/**
 * Box statistics and drawn points already computed, per page-values array and
 * points mode. They depend on nothing else, while the plot is redrawn for every
 * option change. Page-data arrays are never edited once published, and the
 * map holds them weakly.
 * @type {WeakMap<ArrayLike<number>, Map<string, import('../plotly-box-statistics.js').PlotlyBoxSummary>>}
 */
const boxSummaryCache = new WeakMap();

/** @returns {Map<string, import('../plotly-box-statistics.js').PlotlyBoxSummary>} */
function summariesFor(pageValues) {
  let summaries = boxSummaryCache.get(pageValues);
  if (summaries === undefined) {
    summaries = new Map();
    boxSummaryCache.set(pageValues, summaries);
  }
  return summaries;
}

/** The points mode a box hands Plotly precomputed, or null for a raw box. */
function precomputedPointsMode(options) {
  if (options.notched || options.showPoints === 'none') return null;
  return options.showPoints === 'all' ? 'all' : 'outliers';
}

/**
 * Compute the box statistics of every large page on the analysis workers
 * before the plot is drawn. Each is the same `plotlyBoxSummary` wherever it
 * runs, so the drawn box is identical to one computed on this thread.
 *
 * @param {Object[]} pageData
 * @param {Object} options
 * @param {AbortSignal|null} [signal] - Cancels the worker tasks
 */
async function ensureBoxSummaries(pageData, options, signal = null) {
  const mode = precomputedPointsMode(options);
  if (mode === null) return;
  const work = [];
  for (const pd of pageData) {
    const summaries = summariesFor(pd.values);
    if (summaries.has(mode) || pd.values.length < WORKER_MIN_VALUES) continue;
    work.push({ pd, summaries });
  }
  if (work.length === 0) return;
  const manager = getComputeManager();
  await manager.init();
  await Promise.all(work.map(async ({ pd, summaries }) => {
    // The worker filters the page too and hands back its finite values, so
    // this thread never scans it.
    const { summary, finiteCount, finite } = await manager.execute(
      OperationType.COMPUTE_BOX_STATISTICS,
      { values: ArrayBuffer.isView(pd.values) ? pd.values : Float64Array.from(pd.values), points: mode },
      { transfer: !ArrayBuffer.isView(pd.values), signal }
    );
    adoptFiniteNumbers(pd.values, finiteCount, finite);
    if (summary !== null && !summaries.has(mode)) summaries.set(mode, summary);
  }));
}

const boxplotDefinition = {
  id: 'boxplot',
  name: 'Box plot',
  description: 'Compare continuous value distributions across pages',
  supportedTypes: ['continuous'],
  supportedLayouts: ['side-by-side', 'grouped', 'overlay'],

  defaultOptions: {
    orientation: 'vertical',
    showPoints: 'outliers',
    jitter: 30,
    markerSize: 4,
    notched: false,
    showMean: false,
    logScale: false,
    showGrid: true,
    boxWidth: 60
  },

  optionSchema: {
    orientation: {
      type: 'select',
      label: 'Orientation',
      options: [
        { value: 'vertical', label: 'Vertical' },
        { value: 'horizontal', label: 'Horizontal' }
      ]
    },
    showPoints: {
      type: 'select',
      label: 'Points',
      options: [
        { value: 'none', label: 'None' },
        { value: 'outliers', label: 'Outliers' },
        { value: 'all', label: 'All' }
      ]
    },
    jitter: {
      type: 'range',
      label: 'Jitter',
      min: 0,
      max: 100,
      step: 10,
      showWhen: (opts) => opts.showPoints === 'all'
    },
    markerSize: {
      type: 'range',
      label: 'Point size',
      min: 2,
      max: 12,
      step: 1,
      showWhen: (opts) => opts.showPoints !== 'none'
    },
    boxWidth: {
      type: 'range',
      label: 'Box width',
      min: 20,
      max: 100,
      step: 10
    },
    logScale: { type: 'checkbox', label: 'Log scale' },
    notched: { type: 'checkbox', label: 'Notches' },
    showMean: { type: 'checkbox', label: 'Show mean ± SD' },
    showGrid: { type: 'checkbox', label: 'Grid lines' }
  },

  buildTraces(pageData, options, layoutEngine) {
    return PlotFactory.createTraces({
      pageData,
      options,
      layoutEngine,
      filterNumeric: true,
      minValues: 1,
      traceBuilder: (pd, color, i, opts) => {
        const mode = precomputedPointsMode(opts);
        const boxSummary = mode === null
          ? null
          : boxSummaryCache.get(pageData[i].values)?.get(mode) ?? null;
        return PlotFactory.buildDistributionTrace({ type: 'box', pd, color, options: opts, boxSummary });
      }
    });
  },

  buildLayout(pageData, options) {
    const layout = PlotFactory.createLayout({ pageData, options });
    PlotFactory.configureDistributionAxes(layout, { pageData, options });
    layout.boxmode = 'group';
    return layout;
  },

  /**
   * `run.signal` (the detailed analysis's job) cancels the worker tasks the
   * plot computes its statistics with; nothing partial is kept.
   */
  async render(pageData, options, container, layoutEngine, run = {}) {
    await ensureBoxSummaries(pageData, options, run.signal ?? null);
    return PlotFactory.render({ definition: this, pageData, options, container, layoutEngine });
  },

  async update(figure, pageData, options, layoutEngine) {
    await ensureBoxSummaries(pageData, options);
    return PlotFactory.update({ definition: this, figure, pageData, options, layoutEngine });
  },

  exportCSV(pageData, options) {
    return PlotFactory.exportDistributionCSV(pageData, { metadata: { plotType: 'boxplot' } });
  }
};

PlotRegistry.register(boxplotDefinition);
export default boxplotDefinition;
