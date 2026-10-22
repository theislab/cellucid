/**
 * A large page's density curve is summed in slices of evaluation points across
 * the analysis workers before the plot is drawn. This spec renders the
 * application's density definition in the real engine for a continuous field
 * large enough to take the worker path and requires every drawn point to equal,
 * with `Object.is`, the curve the one-thread trace builder sums for the same
 * values.
 */
import { expect, test } from './helpers/test.mjs';
import { openPlotHarness } from './helpers/plot-harness.mjs';


test('worker-summed density curves equal the one-thread curves bit for bit', async ({ page }) => {
  await openPlotHarness(page);
  const report = await page.evaluate(async () => {
    const host = document.getElementById('plot-host');
    host.style.width = '640px';
    host.style.height = '420px';
    let state = 99;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    // More distinct values than the tabulation bound, and enough of them that
    // 100 evaluation points exceed the worker threshold.
    const continuous = Float32Array.from({ length: 250000 }, () => Math.fround(random() * 8 - 2));
    continuous[3] = NaN;
    const quantized = Float32Array.from({ length: 250000 }, () => (
      random() < 0.5 ? 0 : Math.fround(Math.round(random() * 254) / 50)
    ));
    const variableInfo = { key: 'S', name: 'S', kind: 'continuous' };
    const definition = (await import('/assets/js/app/analysis/plots/types/densityplot.js')).default;
    const { getComputeManager } = await import('/assets/js/app/analysis/compute/compute-manager.js');
    const manager = getComputeManager();
    const execute = manager.execute.bind(manager);
    let dispatched = 0;
    manager.execute = (operation, ...rest) => {
      if (operation === 'COMPUTE_KERNEL_DENSITY') dispatched++;
      return execute(operation, ...rest);
    };
    const results = [];
    for (const bandwidth of ['auto', 'narrow']) {
      const pageData = [
        { pageId: 'c', pageName: 'C', values: continuous, cellCount: continuous.length, variableInfo },
        { pageId: 'q', pageName: 'Q', values: quantized, cellCount: quantized.length, variableInfo },
      ];
      const options = { ...definition.defaultOptions, bandwidth };
      const before = dispatched;
      await definition.render(pageData, options, host, null);
      const slices = dispatched - before;
      const drawn = host.data.map(trace => ({ x: Array.from(trace.x), y: Array.from(trace.y) }));
      // Fresh arrays carry no cached curve, so this is the one-thread sum.
      const reference = definition.buildTraces(
        pageData.map(pd => ({ ...pd, values: pd.values.slice() })),
        options,
        null,
      );
      const backend = manager.getStatus().worker.status;
      let mismatches = 0;
      for (let t = 0; t < reference.length; t++) {
        for (let i = 0; i < reference[t].y.length; i++) {
          if (!Object.is(drawn[t].y[i], reference[t].y[i]) || !Object.is(drawn[t].x[i], reference[t].x[i])) mismatches++;
        }
      }
      results.push({ bandwidth, traces: drawn.length, points: drawn[0].y.length, mismatches, backend, slices });
      window.Plotly.purge(host);
    }
    delete manager.execute;
    return results;
  });
  for (const result of report) {
    expect(result.traces).toBe(2);
    expect(result.points).toBe(100);
    expect(result.backend, 'the analysis workers are available').toBe('available');
    expect(result.slices, 'the large curve was summed in worker slices').toBeGreaterThan(1);
    expect(result.mismatches, `${result.bandwidth} curve differs from the one-thread sum`).toBe(0);
  }
});
