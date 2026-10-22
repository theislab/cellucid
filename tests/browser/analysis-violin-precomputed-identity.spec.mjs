/**
 * A large page's violin hands the vendored Plotly the calcdata entry its box
 * calc would build (`_precomputedViolin`, plotlyViolinBox in
 * plotly-box-statistics.js), so Plotly no longer builds a record per value. This
 * spec draws the application's violin traces twice in the real engine — once
 * through Plotly's own calc (the precomputed entry removed) and once through the
 * precomputed one — for every option that changes the calc or the drawing, and
 * requires the same calcdata statistics, density, autorange and SVG. The one
 * deliberate difference is the documented cap on identical outliers
 * (COINCIDENT_OUTLIER_COPIES), so the fixtures here have none above it, and a
 * last case checks the cap itself.
 */
import { expect, test } from './helpers/test.mjs';
import { openPlotHarness } from './helpers/plot-harness.mjs';

test('the precomputed violin calc draws exactly what Plotly computes', async ({ page }) => {
  test.setTimeout(180_000);
  await openPlotHarness(page);
  const report = await page.evaluate(async () => {
    let state = 99;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const normal = () => {
      const u = Math.max(random(), 1e-12);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
    };
    // Continuous with far outliers on both sides; quantized with many ties but
    // no outlier value repeated more than the cap.
    const continuous = Float32Array.from({ length: 30000 }, () => Math.fround(normal() * 2 + 5));
    for (let i = 0; i < 40; i++) continuous[i * 7] = Math.fround(30 + i);
    const quantized = Float32Array.from({ length: 25000 }, () => (
      random() < 0.5 ? 0 : Math.fround(Math.round(random() * 200) * (3.1 / 254))
    ));
    for (let i = 0; i < 12; i++) quantized[i * 11] = Math.fround(9 + i);
    const variableInfo = { key: 'G1', name: 'G1', kind: 'continuous' };
    const definition = (await import('/assets/js/app/analysis/plots/types/violinplot.js')).default;
    const host = document.getElementById('plot-host');
    const pages = [
      { pageId: 'c', pageName: 'Continuous', values: continuous, cellCount: continuous.length, variableInfo },
      { pageId: 'q', pageName: 'Quantized', values: quantized, cellCount: quantized.length, variableInfo },
    ];
    const optionSets = [
      {},
      { showPoints: 'outliers' },
      { showPoints: 'outliers', orientation: 'horizontal', side: 'positive', showMeanLine: true },
      { showBox: false, side: 'negative' },
    ];
    const statKeys = ['pos', 'min', 'max', 'mean', 'sd', 'med', 'q1', 'q3', 'lf', 'uf', 'lo', 'uo', 'ln', 'un', 'bandwidth'];
    const sameNumber = (a, b) => Object.is(a, b);
    const cases = [];
    for (const extra of optionSets) {
      const options = { ...definition.defaultOptions, ...extra };
      await definition.render(pages, options, host, null);
      const traces = host.data.map(trace => ({ ...trace }));
      const layout = JSON.parse(JSON.stringify(host.layout));
      const draw = async data => {
        const div = document.createElement('div');
        div.style.cssText = 'width:640px;height:420px;position:absolute;left:0;top:0';
        document.body.appendChild(div);
        await window.Plotly.newPlot(div, data, layout, { staticPlot: false });
        const result = {
          calc: div.calcdata.map(cd => cd[0]),
          extremes: div._fullData.map(t => JSON.stringify(t._extremes)),
          svg: div.querySelector('.violinlayer').innerHTML,
          range: JSON.stringify([div._fullLayout.xaxis.range, div._fullLayout.yaxis.range]),
        };
        return { div, result };
      };
      const fast = await draw(traces);
      const raw = await draw(traces.map(({ _precomputedViolin, ...trace }) => trace));
      const mismatches = [];
      fast.result.calc.forEach((entry, index) => {
        const reference = raw.result.calc[index];
        for (const key of statKeys) {
          if (!sameNumber(entry[key], reference[key])) mismatches.push(`${index}.${key}: ${entry[key]} vs ${reference[key]}`);
        }
        if (JSON.stringify(entry.span) !== JSON.stringify(reference.span)) mismatches.push(`${index}.span`);
        if (entry.density.length !== reference.density.length
          || entry.density.some((d, k) => !sameNumber(d.v, reference.density[k].v) || !sameNumber(d.t, reference.density[k].t))) {
          mismatches.push(`${index}.density`);
        }
        const drawn = list => list.map(p => p.v).join(',');
        if (options.showPoints !== 'none' && drawn(entry.pts2) !== drawn(reference.pts2)) mismatches.push(`${index}.pts2`);
        if (JSON.stringify(entry.t) !== JSON.stringify(reference.t)) mismatches.push(`${index}.t`);
        if (entry._vals === undefined) mismatches.push(`${index}: the precomputed calc was not taken`);
      });
      if (fast.result.extremes.join() !== raw.result.extremes.join()) mismatches.push('extremes');
      if (fast.result.range !== raw.result.range) mismatches.push('axis ranges');
      if (fast.result.svg !== raw.result.svg) mismatches.push('svg');
      cases.push({ options: extra, mismatches, svgLength: fast.result.svg.length });
      for (const { div } of [fast, raw]) {
        window.Plotly.purge(div);
        div.remove();
      }
    }

    // The cap: a zero-inflated page whose expressing cells are all outliers
    // draws each identical value at most 16 times, and every distinct value.
    const inflated = Float32Array.from({ length: 40000 }, (_, i) => (i % 10 === 0 ? Math.fround(1 + (i % 7)) : 0));
    await definition.render(
      [{ pageId: 'z', pageName: 'Inflated', values: inflated, cellCount: inflated.length, variableInfo }],
      { ...definition.defaultOptions, showPoints: 'outliers' },
      host,
      null,
    );
    const drawnValues = host.calcdata[0][0].pts2.map(p => p.v);
    const copies = new Map();
    for (const v of drawnValues) copies.set(v, (copies.get(v) ?? 0) + 1);
    return {
      cases,
      cap: { distinct: [...copies.keys()].sort((a, b) => a - b), most: Math.max(...copies.values()) },
    };
  });

  expect(report.cases).toHaveLength(4);
  for (const entry of report.cases) {
    expect(entry.mismatches, JSON.stringify(entry.options)).toEqual([]);
    expect(entry.svgLength).toBeGreaterThan(100);
  }
  expect(report.cap.distinct).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(report.cap.most).toBe(16);
});
