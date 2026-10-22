/**
 * The violin plot draws the density Plotly computes, and the vendored Plotly
 * carries a local `makeKDE` patch (see the header of
 * assets/external/plotly.min.js and tests/plotly-violin-kde-contract.test.mjs).
 * The patch skips values whose kernel is exactly 0 — 39 or more bandwidths away
 * — which relies on each engine's `Math.exp` underflowing to 0 there. A large
 * page's density is summed by the analysis workers instead and read back by
 * the patched `makeKDE` (plotly-violin-density.js). This spec renders the
 * application's violin definition in the real engine and checks every drawn
 * density value against the upstream per-value sum, with `Object.is`, for
 * quantized expression and for continuous values with far tails, and that a
 * large page's drawn density is the worker-summed one, read point by point.
 */
import { expect, test } from './helpers/test.mjs';
import { openPlotHarness } from './helpers/plot-harness.mjs';


test('violin densities are the upstream per-value kernel sums, bit for bit', async ({ page }) => {
  await openPlotHarness(page);
  let report = await page.evaluate(async () => {
    const host = document.getElementById('plot-host');
    host.style.width = '640px';
    host.style.height = '420px';
    let state = 12345;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const quantized = Float32Array.from({ length: 20000 }, () => (
      random() < 0.7 ? 0 : Math.fround(Math.round(random() * 254) * (3.1 / 254))
    ));
    // Large and distinct: the worker-summed path.
    const large = Float32Array.from({ length: 30000 }, () => Math.fround(random() * 6 - 1));
    large[7] = 25;
    // Zero-inflated continuous values: ties make up most of the sample, so the
    // run-and-window path draws it.
    const continuous = Float32Array.from({ length: 6000 }, (_, i) => {
      if (i % 5 < 3) return 0;
      const u = Math.max(random(), 1e-12);
      return Math.fround(Math.abs(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random())));
    });
    // Far tails: whole stretches of the grid sit 39+ bandwidths from them.
    continuous[0] = 60;
    continuous[1] = -45;
    const variableInfo = { key: 'G1', name: 'G1', kind: 'continuous' };
    const definition = (
      await import('/assets/js/app/analysis/plots/types/violinplot.js')
    ).default;
    await definition.render(
      [
        { pageId: 'q', pageName: 'Quantized', values: quantized, cellCount: quantized.length, variableInfo },
        { pageId: 'c', pageName: 'Continuous', values: continuous, cellCount: continuous.length, variableInfo },
        { pageId: 'l', pageName: 'Large', values: large, cellCount: large.length, variableInfo },
      ],
      { ...definition.defaultOptions },
      host,
      null,
    );
    const kernel = t => 1 / Math.sqrt(2 * Math.PI) * Math.exp(-0.5 * t * t);
    // Draw each worker-summed trace again with its table instrumented, and
    // count the grid points Plotly read from it rather than summed.
    const readBack = [];
    for (const trace of host.data) {
      const table = trace._precomputedKDE;
      if (table === undefined) {
        readBack.push(null);
        continue;
      }
      let reads = 0;
      const v = new Proxy(table.v, {
        get(target, key) {
          if (typeof key === 'string' && /^[0-9]+$/.test(key)) reads++;
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const div = document.createElement('div');
      div.style.cssText = 'width:300px;height:300px';
      document.body.appendChild(div);
      await window.Plotly.newPlot(div, [{ ...trace, _precomputedKDE: { ...table, v } }], {});
      readBack.push({ reads, drawn: div.calcdata[0][0].density.length });
      window.Plotly.purge(div);
      div.remove();
    }
    const traces = host.calcdata.map(trace => {
      const box = trace[0];
      // A worker-planned page carries its values as an array instead of a
      // point record per value (the precomputed violin calc).
      const values = box._vals ?? box.pts.map(point => point.v);
      const bandwidth = box.bandwidth;
      const scale = 1 / (values.length * bandwidth);
      let mismatches = 0;
      let zeroTerms = 0;
      for (const { v, t } of box.density) {
        let sum = 0;
        for (let i = 0; i < values.length; i++) {
          const term = kernel((t - values[i]) / bandwidth);
          if (term === 0) zeroTerms++;
          sum += term;
        }
        if (!Object.is(scale * sum, v)) mismatches++;
      }
      return { name: trace[0].trace.name, points: box.density.length, mismatches, zeroTerms };
    });
    return { traces, readBack };
  });

  expect(report.readBack[2], 'the large page carries a worker-summed density').not.toBeNull();
  // Every grid point is read back each time Plotly runs the violin calc.
  const { reads, drawn } = report.readBack[2];
  expect(drawn).toBeGreaterThan(10);
  expect(reads > 0 && reads % drawn === 0, `${reads} reads of ${drawn} grid points`).toBe(true);
  report = report.traces;
  expect(report).toHaveLength(3);
  for (const trace of report) {
    expect(trace.points, `${trace.name} draws a density`).toBeGreaterThan(10);
    expect(trace.mismatches, `${trace.name} densities differ from upstream`).toBe(0);
  }
  expect(
    report[1].zeroTerms,
    'the continuous fixture must exercise the exact-zero window',
  ).toBeGreaterThan(0);
});
