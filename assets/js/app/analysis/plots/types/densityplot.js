/**
 * Density Plot Type
 *
 * Kernel density estimation for continuous variables.
 * Supports overlay mode for comparing multiple pages on the same axes.
 * Refactored to use PlotFactory for reduced code duplication.
 */

import { PlotFactory, PlotRegistry, BasePlot, COMMON_HOVER_STYLE } from '../plot-factory.js';
import { PLOTLY_2D_SCATTER_TRACE_TYPE } from '../plotly-loader.js';
import { adoptFiniteNumbers, finiteNumbers, mean } from '../../shared/number-utils.js';
import { kernelDensityAt } from '../../compute/math-utils.js';
import {
  curveOf,
  densityCurveOrPlan,
  getBandwidthMultiplier,
  planDensity
} from '../density-curve.js';
import { getComputeManager } from '../../compute/compute-manager.js';
import { OperationType } from '../../compute/operations.js';
import { escapeHtml } from '../../../utils/dom-utils.js';

/**
 * Kernel terms below which a curve is summed on the calling thread: about
 * 40 ms of work, within one main-thread task. Past it the sum is handed to
 * the analysis workers even where that is not faster end to end (a
 * 25,000-value page drew in 66 ms on the main thread and 105 ms through the
 * workers), because the main thread stays free: a 100,000-value continuous
 * page held it for 135 ms at the earlier threshold of 20 million terms.
 */
const PARALLEL_MIN_KERNEL_TERMS = 3_000_000;

/**
 * Density curves already computed, per page-values array and bandwidth
 * multiplier. A curve depends on nothing else, while the plot is redrawn for
 * every option change — fill, mean line, log axes — and once more for CSV
 * export; each redraw used to re-run the kernel sum, a full pass of 100
 * kernel evaluations per cell. Page-data arrays are never edited once
 * published, and the map holds them weakly.
 * @type {WeakMap<ArrayLike<number>, Map<number, {x: number[], y: number[]}>>}
 */
const densityCurveCache = new WeakMap();

/**
 * Values in a page from which its density is also planned by an analysis
 * worker: filtering, the bandwidth and the support count are passes over every
 * value.
 */
const WORKER_MIN_VALUES = 200_000;

/**
 * Each page's mean, as `ensurePageDensities` computed it for the mean line.
 * @type {WeakMap<ArrayLike<number>, number>}
 */
const pageMeans = new WeakMap();

/** @returns {Map<number, {x: number[], y: number[]}>} */
function curvesFor(pageValues) {
  let curves = densityCurveCache.get(pageValues);
  if (curves === undefined) {
    curves = new Map();
    densityCurveCache.set(pageValues, curves);
  }
  return curves;
}

/**
 * The density curve of a page's finite values, summed on this thread unless
 * `ensurePageDensities` already computed it.
 * @param {ArrayLike<number>} pageValues - A page's `values`, as published
 * @param {number} bandwidthMult
 * @returns {{x: number[], y: number[]}}
 */
function pageDensity(pageValues, bandwidthMult) {
  const curves = curvesFor(pageValues);
  let curve = curves.get(bandwidthMult);
  if (curve === undefined) {
    const plan = planDensity(finiteNumbers(pageValues), bandwidthMult);
    curve = plan.curve ?? curveOf(
      plan,
      kernelDensityAt(plan.support, plan.weights, plan.x, plan.h, plan.n)
    );
    curves.set(bandwidthMult, curve);
  }
  return curve;
}

/**
 * Compute every page's density curve before the plot is drawn. A large page's
 * kernel sum (a hundred evaluations per distinct value: 1.4 s on the main
 * thread for a million-cell continuous field) is split by evaluation point
 * across the analysis workers; each point is the same `kernelDensityAt` loop
 * wherever it runs, so the curve is identical to the one-thread sum.
 *
 * @param {Array<{values: ArrayLike<number>}>} pageData
 * @param {number} bandwidthMult
 * @param {AbortSignal|null} [signal] - Cancels the worker tasks
 */
async function ensurePageDensities(pageData, bandwidthMult, signal = null) {
  const work = [];
  const planned = [];
  for (const pd of pageData) {
    const curves = curvesFor(pd.values);
    if (curves.has(bandwidthMult)) continue;
    if (pd.values.length >= WORKER_MIN_VALUES) {
      planned.push({ curves, pd });
      continue;
    }
    const { mean: pageMean, curve, plan } = densityCurveOrPlan(
      pd.values,
      bandwidthMult,
      PARALLEL_MIN_KERNEL_TERMS
    );
    pageMeans.set(pd.values, pageMean);
    if (curve !== undefined) curves.set(bandwidthMult, curve);
    else work.push({ curves, plan });
  }
  if (work.length === 0 && planned.length === 0) return;

  const manager = getComputeManager();
  await manager.init();
  // A large page is planned (filtered, its bandwidth and grid chosen, its
  // support counted) by a worker too, so no pass over it runs here.
  await Promise.all(planned.map(async ({ curves, pd }) => {
    const { mean: pageMean, curve, plan, finiteCount, finite } = await manager.execute(
      OperationType.COMPUTE_DENSITY_PLAN,
      {
        values: ArrayBuffer.isView(pd.values) ? pd.values : Float64Array.from(pd.values),
        bandwidthMult,
        maxKernelTerms: PARALLEL_MIN_KERNEL_TERMS
      },
      { transfer: false, signal }
    );
    adoptFiniteNumbers(pd.values, finiteCount, finite);
    pageMeans.set(pd.values, pageMean);
    if (curve !== undefined) {
      if (!curves.has(bandwidthMult)) curves.set(bandwidthMult, curve);
    } else {
      work.push({ curves, plan });
    }
  }));
  if (work.length === 0) return;

  const workers = manager.getStatus().worker.stats?.poolSize ?? 1;
  await Promise.all(work.map(async ({ curves, plan }) => {
    const xs = Float64Array.from(plan.x);
    const slices = Math.max(1, Math.min(workers, xs.length));
    const size = Math.ceil(xs.length / slices);
    const parts = await Promise.all(Array.from({ length: slices }, (_, slice) => (
      manager.execute(
        OperationType.COMPUTE_KERNEL_DENSITY,
        {
          support: plan.support,
          weights: plan.weights,
          xs: xs.slice(slice * size, (slice + 1) * size),
          bandwidth: plan.h,
          count: plan.n
        },
        { transfer: false, signal }
      )
    )));
    const density = new Float64Array(xs.length);
    parts.forEach((part, slice) => density.set(part.density, slice * size));
    if (!curves.has(bandwidthMult)) curves.set(bandwidthMult, curveOf(plan, density));
  }));
}

const densityplotDefinition = {
  id: 'densityplot',
  name: 'Density plot',
  description: 'Smoothed distribution curve',
  supportedTypes: ['continuous'],
  supportedLayouts: ['overlay', 'side-by-side'],

  defaultOptions: {
    fillOpacity: 30,
    bandwidth: 'auto',
    showMean: true,
    logX: false,
    logY: false
  },

  optionSchema: {
    fillOpacity: { type: 'range', label: 'Fill', min: 0, max: 100, step: 10 },
    bandwidth: {
      type: 'select',
      label: 'Bandwidth',
      options: [
        { value: 'auto', label: 'Auto' },
        { value: 'narrow', label: 'Narrow' },
        { value: 'wide', label: 'Wide' }
      ]
    },
    logX: { type: 'checkbox', label: 'Log X' },
    logY: { type: 'checkbox', label: 'Log Y' },
    showMean: { type: 'checkbox', label: 'Mean line' }
  },

  buildTraces(pageData, options, layoutEngine) {
    const bandwidthMult = getBandwidthMultiplier(options.bandwidth);
    const fillOpacity = (options.fillOpacity || 30) / 100;

    return PlotFactory.createTraces({
      pageData, options, layoutEngine, filterNumeric: true, minValues: 1,
      traceBuilder: (pd, color, i, _opts) => {
        const { x, y } = pageDensity(pageData[i].values, bandwidthMult);
        if (x.length === 0) return null;

        // Cross-browser SVG density curve.
        return {
          type: PLOTLY_2D_SCATTER_TRACE_TYPE,
          mode: 'lines',
          x, y,
          name: escapeHtml(pd.pageName),
          line: { color, width: 2, shape: 'spline' },
          fill: 'tozeroy',
          fillcolor: PlotFactory.hexToRgba(color, fillOpacity),
          hovertemplate: `${escapeHtml(pd.pageName)}<br>Value: %{x:.2f}<br>Density: %{y:.4f}<extra></extra>`,
          hoverlabel: COMMON_HOVER_STYLE
        };
      }
    });
  },

  buildLayout(pageData, options, layoutEngine) {
    const layout = PlotFactory.createLayout({ pageData, options });
    // Dataset-supplied field name reaching a markup-parsing axis title.
    const variableName = escapeHtml(BasePlot.getVariableName(pageData));

    layout.xaxis = { title: variableName, automargin: true, type: options.logX ? 'log' : 'linear' };
    layout.yaxis = { title: 'Density', zeroline: true, rangemode: 'tozero', type: options.logY ? 'log' : 'linear' };

    // Add mean lines as shapes
    if (options.showMean) {
      layout.shapes = [];
      pageData.forEach((pd, i) => {
        let meanVal = pageMeans.get(pd.values);
        if (meanVal === undefined) {
          const values = finiteNumbers(pd.values);
          meanVal = values.length === 0 ? NaN : mean(values);
        }
        if (Number.isNaN(meanVal)) return;
        const color = BasePlot.getPageColor(layoutEngine, pd.pageId, i);
        layout.shapes.push({
          type: 'line',
          x0: meanVal, x1: meanVal, y0: 0, y1: 1,
          yref: 'paper',
          line: { color, width: 2, dash: 'dash' }
        });
      });
    }

    return layout;
  },

  /**
   * `run.signal` (the detailed analysis's job) cancels the worker tasks the
   * plot computes its statistics with; nothing partial is kept.
   */
  async render(pageData, options, container, layoutEngine, run = {}) {
    await ensurePageDensities(pageData, getBandwidthMultiplier(options.bandwidth), run.signal ?? null);
    return PlotFactory.render({ definition: this, pageData, options, container, layoutEngine });
  },

  async update(figure, pageData, options, layoutEngine) {
    await ensurePageDensities(pageData, getBandwidthMultiplier(options.bandwidth));
    return PlotFactory.update({ definition: this, figure, pageData, options, layoutEngine });
  },

  exportCSV(pageData, options) {
    const bandwidthMult = getBandwidthMultiplier(options.bandwidth);
    const rows = [];

    for (const pd of pageData) {
      const { x, y } = pageDensity(pd.values, bandwidthMult);
      if (x.length === 0) continue;

      for (let i = 0; i < x.length; i++) {
        rows.push({ page: pd.pageName, x: x[i].toFixed(4), density: y[i].toFixed(6) });
      }
    }

    return {
      rows,
      columns: ['page', 'x', 'density'],
      metadata: { plotType: 'densityplot', pageCount: pageData.length, bandwidth: options.bandwidth, exportDate: new Date().toISOString() }
    };
  }
};

PlotRegistry.register(densityplotDefinition);
export default densityplotDefinition;
