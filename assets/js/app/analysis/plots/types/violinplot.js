/**
 * Violin Plot for Page Analysis
 *
 * Displays distribution of continuous values using kernel density estimation,
 * providing a richer view of the data distribution than box plots.
 * Refactored to use PlotFactory for reduced code duplication.
 */

import { PlotFactory, PlotRegistry } from '../plot-factory.js';
import { adoptFiniteNumbers } from '../../shared/number-utils.js';
import { getComputeManager } from '../../compute/compute-manager.js';
import { OperationType } from '../../compute/operations.js';

/**
 * Finite values from which a page's violin density is summed by the analysis
 * workers. Below this Plotly's own violin calc stays within one short task.
 */
const WORKER_MIN_VALUES = 20_000;

/**
 * Violin inputs already computed, per page-values array: the values in the
 * order Plotly's box calc sorts them, the calcdata entry that calc builds
 * from them (`plotlyViolinBox`), and the density Plotly's violin calc would
 * sum at its grid (null for a single-value violin, which has none). All three
 * depend on the values alone — the violin options change how it is drawn, not
 * what it is. Page-data arrays are never edited once published, and the map
 * holds them weakly.
 * @type {WeakMap<ArrayLike<number>, {sorted: Float64Array, box: import('../plotly-box-statistics.js').PlotlyViolinBox, kde: {bandwidth: number, count: number, t: Float64Array, v: Float64Array}|null}>}
 */
const violinInputCache = new WeakMap();

/**
 * Sum every large page's violin density on the analysis workers before the
 * plot is drawn, in slices of the evaluation grid. Each slice is the same
 * arithmetic Plotly's violin calc performs, so the density Plotly reads back
 * is the one it would have summed itself (plotly-violin-density.js), and
 * handing Plotly the values already in its own sort order turns its per-value
 * sort into one linear pass.
 *
 * @param {Object[]} pageData
 * @param {AbortSignal|null} [signal] - Cancels the worker tasks
 */
async function ensureViolinInputs(pageData, signal = null) {
  const work = [];
  for (const pd of pageData) {
    if (violinInputCache.has(pd.values) || pd.values.length < WORKER_MIN_VALUES) continue;
    const values = ArrayBuffer.isView(pd.values) ? pd.values : Float64Array.from(pd.values);
    work.push({ key: pd.values, values });
  }
  if (work.length === 0) return;
  const manager = getComputeManager();
  await manager.init();
  const workers = manager.getStatus().worker.stats?.poolSize ?? 1;
  const slice = (values, from, to, includeSorted) => manager.execute(
    OperationType.COMPUTE_VIOLIN_DENSITY,
    { values, from, to, includeSorted },
    { transfer: false, signal }
  );
  await Promise.all(work.map(async ({ key, values }) => {
    // The first call plans the violin and hands back the page's finite values
    // and their sorted order, so this thread never scans the page.
    const plan = await slice(values, 0, 0, true);
    if (plan.empty === true) return;
    adoptFiniteNumbers(key, plan.finiteCount, plan.finite);
    let kde = null;
    if (plan.count > 0) {
      const slices = Math.max(1, Math.min(workers, plan.count));
      const size = Math.ceil(plan.count / slices);
      const parts = await Promise.all(Array.from({ length: slices }, (_, index) => (
        slice(values, index * size, Math.min(plan.count, (index + 1) * size), false)
      )));
      const t = new Float64Array(plan.count);
      const v = new Float64Array(plan.count);
      parts.forEach((part, index) => {
        t.set(part.t, index * size);
        v.set(part.v, index * size);
      });
      kde = { bandwidth: plan.bandwidth, count: plan.sorted.length, t, v };
    }
    if (!violinInputCache.has(key)) {
      violinInputCache.set(key, { sorted: plan.sorted, box: plan.box, kde });
    }
  }));
}

const violinplotDefinition = {
  id: 'violinplot',
  name: 'Violin Plot',
  description: 'Compare value distributions with density visualization',
  supportedTypes: ['continuous'],
  supportedLayouts: ['side-by-side', 'grouped', 'overlay'],

  defaultOptions: {
    orientation: 'vertical',
    showBox: true,
    showMeanLine: false,
    showPoints: 'none',
    side: 'both',
    logScale: false,
    showGrid: true,
    markerSize: 3,
    violinWidth: 80
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
    side: {
      type: 'select',
      label: 'Violin Side',
      options: [
        { value: 'both', label: 'Both sides' },
        { value: 'positive', label: 'Right only' },
        { value: 'negative', label: 'Left only' }
      ]
    },
    violinWidth: {
      type: 'range',
      label: 'Width',
      min: 40,
      max: 100,
      step: 10
    },
    showBox: { type: 'checkbox', label: 'Box inside' },
    showMeanLine: { type: 'checkbox', label: 'Mean line' },
    showPoints: {
      type: 'select',
      label: 'Points',
      options: [
        { value: 'none', label: 'None' },
        { value: 'outliers', label: 'Outliers' },
        { value: 'all', label: 'All' }
      ]
    },
    markerSize: {
      type: 'range',
      label: 'Point Size',
      min: 2,
      max: 10,
      step: 1,
      showWhen: (opts) => opts.showPoints !== 'none'
    },
    logScale: { type: 'checkbox', label: 'Log scale' },
    showGrid: { type: 'checkbox', label: 'Grid lines' }
  },

  buildTraces(pageData, options, layoutEngine) {
    return PlotFactory.createTraces({
      pageData,
      options,
      layoutEngine,
      filterNumeric: true,
      minValues: 2, // Need at least 2 points for violin
      traceBuilder: (pd, color, i, opts) =>
        PlotFactory.buildDistributionTrace({
          type: 'violin',
          pd,
          color,
          options: opts,
          violinInput: violinInputCache.get(pageData[i].values) ?? null
        })
    });
  },

  buildLayout(pageData, options) {
    const layout = PlotFactory.createLayout({ pageData, options });
    PlotFactory.configureDistributionAxes(layout, { pageData, options });
    layout.violinmode = 'overlay';
    layout.violingap = 0.1;
    layout.violingroupgap = 0.2;
    return layout;
  },

  /**
   * `run.signal` (the detailed analysis's job) cancels the worker tasks the
   * plot computes its statistics with; nothing partial is kept.
   */
  async render(pageData, options, container, layoutEngine, run = {}) {
    await ensureViolinInputs(pageData, run.signal ?? null);
    return PlotFactory.render({ definition: this, pageData, options, container, layoutEngine });
  },

  async update(figure, pageData, options, layoutEngine) {
    await ensureViolinInputs(pageData);
    return PlotFactory.update({ definition: this, figure, pageData, options, layoutEngine });
  },

  exportCSV(pageData, options) {
    return PlotFactory.exportDistributionCSV(pageData, {
      metadata: {
        plotType: 'violinplot',
        variable: pageData[0]?.variableInfo?.name || 'Value'
      }
    });
  }
};

PlotRegistry.register(violinplotDefinition);
export default violinplotDefinition;
