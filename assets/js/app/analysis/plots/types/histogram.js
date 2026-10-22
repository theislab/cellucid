/**
 * Histogram for Page Analysis
 *
 * Displays binned distribution of continuous values across pages.
 * Refactored to use PlotFactory for reduced code duplication.
 */

import { PlotFactory, PlotRegistry, COMMON_HOVER_STYLE } from '../plot-factory.js';
import { escapeHtml } from '../../../utils/dom-utils.js';
import { histogramSamples } from '../plotly-histogram-bins.js';
import { adoptFiniteNumbers } from '../../shared/number-utils.js';
import { getComputeManager } from '../../compute/compute-manager.js';
import { OperationType } from '../../compute/operations.js';

/**
 * Values (over all pages) from which a histogram's bins and samples are
 * computed by an analysis worker before it is drawn.
 */
const WORKER_MIN_VALUES = 200_000;

/**
 * Bins and samples already computed, per first page-values array: the arrays
 * and bin count they were computed for, and the result. Page-data arrays are
 * never edited once published, and the map holds them weakly.
 * @type {WeakMap<ArrayLike<number>, Array<{arrays: ArrayLike<number>[], nbins: number, result: import('../plotly-histogram-bins.js').HistogramSamples}>>}
 */
const samplesCache = new WeakMap();

function cachedSamples(pageData, nbins) {
  if (pageData.length === 0) return null;
  const entries = samplesCache.get(pageData[0].values) ?? [];
  const entry = entries.find(candidate => (
    candidate.nbins === nbins &&
    candidate.arrays.length === pageData.length &&
    candidate.arrays.every((values, i) => values === pageData[i].values)
  ));
  return entry?.result ?? null;
}

/**
 * Compute a large histogram's bins and samples on an analysis worker before it
 * is drawn: the same `histogramSamples` wherever it runs.
 *
 * @param {Object[]} pageData
 * @param {number} nbins
 */
async function ensureHistogramSamples(pageData, nbins) {
  if (pageData.length === 0 || cachedSamples(pageData, nbins) !== null) return;
  let total = 0;
  for (const pd of pageData) total += pd.values.length;
  if (total < WORKER_MIN_VALUES) return;
  const manager = getComputeManager();
  await manager.init();
  const { _compute, finite, ...result } = await manager.execute(
    OperationType.COMPUTE_HISTOGRAM_SAMPLES,
    {
      pages: pageData.map(pd => (ArrayBuffer.isView(pd.values) ? pd.values : Float64Array.from(pd.values))),
      nbins
    },
    { transfer: false }
  );
  pageData.forEach((pd, index) => {
    adoptFiniteNumbers(pd.values, finite[index].finiteCount, finite[index].finite);
  });
  const key = pageData[0].values;
  const entries = samplesCache.get(key) ?? [];
  entries.push({ arrays: pageData.map(pd => pd.values), nbins, result });
  samplesCache.set(key, entries);
}

const histogramDefinition = {
  id: 'histogram',
  name: 'Histogram',
  description: 'Compare binned value distributions across pages',
  supportedTypes: ['continuous'],
  supportedLayouts: ['side-by-side', 'overlay', 'stacked'],

  defaultOptions: {
    nbins: 20,
    histnorm: '',
    cumulative: false,
    barmode: 'overlay',
    opacity: 0.7,
    logX: false,
    logY: false
  },

  optionSchema: {
    nbins: { type: 'range', label: 'Bins', min: 5, max: 100, step: 5 },
    histnorm: {
      type: 'select',
      label: 'Normalize',
      options: [
        { value: '', label: 'Count' },
        { value: 'percent', label: 'Percent' },
        { value: 'probability', label: 'Probability' },
        { value: 'density', label: 'Density' }
      ]
    },
    barmode: {
      type: 'select',
      label: 'Mode',
      options: [
        { value: 'overlay', label: 'Overlay' },
        { value: 'stack', label: 'Stacked' },
        { value: 'group', label: 'Grouped' }
      ]
    },
    logX: { type: 'checkbox', label: 'Log X' },
    logY: { type: 'checkbox', label: 'Log Y' },
    cumulative: { type: 'checkbox', label: 'Cumulative' }
  },

  buildTraces(pageData, options, layoutEngine) {
    const { nbins = 20, histnorm = '', cumulative = false, barmode = 'overlay', opacity = 0.7 } = options;
    const { min: globalMin, max: globalMax, size: binSize, samples } =
      cachedSamples(pageData, nbins) ?? histogramSamples(pageData.map(pd => pd.values), nbins);

    return PlotFactory.createTraces({
      pageData,
      options,
      layoutEngine,
      filterNumeric: true,
      minValues: 1,
      traceBuilder: (pd, color, i, opts) => {
        const safePageName = escapeHtml(String(pd.pageName || ''));
        const trace = {
          type: 'histogram',
          name: safePageName,
          nbinsx: nbins,
          histnorm,
          cumulative: { enabled: cumulative },
          marker: { color, line: { color: 'rgba(0,0,0,0.1)', width: 0.5 } },
          opacity: barmode === 'overlay' ? opacity : 1,
          hovertemplate: histnorm === 'percent' || histnorm === 'probability'
            ? `${safePageName}<br>%{x}: %{y:.1f}%<extra></extra>`
            : `${safePageName}<br>%{x}: %{y}<extra></extra>`,
          hoverlabel: COMMON_HOVER_STYLE
        };

        trace.xbins = { start: globalMin, end: globalMax, size: binSize };

        const sample = samples[i];
        if (sample !== null) {
          // Explicit bins: hand Plotly a few values of each bin with summed
          // weights instead of every value. It draws the same bars, heights
          // and hover labels (see plotly-histogram-bins.js).
          trace.x = sample.x;
          trace.y = sample.y;
          trace.histfunc = 'sum';
        } else {
          trace.x = Array.from(pd.values);
        }

        return trace;
      }
    });
  },

  buildLayout(pageData, options) {
    const { barmode = 'overlay', histnorm = '' } = options;
    const layout = PlotFactory.createLayout({ pageData, options, custom: { barmode } });
    PlotFactory.configureHistogramAxes(layout, { pageData, options });
    return layout;
  },

  async render(pageData, options, container, layoutEngine) {
    await ensureHistogramSamples(pageData, options.nbins ?? 20);
    return PlotFactory.render({ definition: this, pageData, options, container, layoutEngine });
  },

  async update(figure, pageData, options, layoutEngine) {
    await ensureHistogramSamples(pageData, options.nbins ?? 20);
    return PlotFactory.update({ definition: this, figure, pageData, options, layoutEngine });
  },

  exportCSV(pageData, options) {
    return PlotFactory.exportHistogramCSV(pageData, options);
  }
};

PlotRegistry.register(histogramDefinition);
export default histogramDefinition;
