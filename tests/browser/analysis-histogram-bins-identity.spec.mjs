/**
 * A histogram hands Plotly a few values per bin with summed weights instead of
 * every value (assets/js/app/analysis/plots/plotly-histogram-bins.js). This
 * spec draws each fixture twice in the real engine — once through the
 * application's histogram definition, once as the raw-value trace it used to
 * build — under every normalization, cumulative mode and bar mode, and
 * requires the same calcdata (bar positions, heights and hover bin ranges,
 * compared with `Object.is`), the same bar geometry, the same autorange and
 * the same hover text.
 */
import { expect, test } from './helpers/test.mjs';
import { openPlotHarness } from './helpers/plot-harness.mjs';


test('representative histogram samples draw exactly the raw-value histogram', async ({ page }) => {
  await openPlotHarness(page);
  const report = await page.evaluate(async () => {
    const definition = (await import('/assets/js/app/analysis/plots/types/histogram.js')).default;
    const { createMinimalPlotly, getPlotlyConfig } = await import('/assets/js/app/analysis/plots/plot-base.js');
    const Plotly = await createMinimalPlotly();
    let state = 77;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const fixtures = {
      quantized: Float32Array.from({ length: 40000 }, () => (
        random() < 0.7 ? 0 : Math.fround(Math.round(random() * 254) * (3.1 / 254))
      )),
      continuous: Float32Array.from({ length: 30000 }, () => Math.fround(random() * 9 - 4)),
      levels: Float32Array.from({ length: 20000 }, () => Math.floor(random() * 6)),
    };
    const variableInfo = { key: 'G', name: 'G', kind: 'continuous' };
    const variants = [
      {},
      { histnorm: 'percent' },
      { histnorm: 'probability' },
      { histnorm: 'density' },
      { cumulative: true },
      { barmode: 'stack' },
      { barmode: 'group', nbins: 45 },
      { nbins: 5 },
    ];
    const host = document.getElementById('plot-host');
    host.style.width = '1200px';
    host.style.height = '440px';
    const box = () => {
      const div = document.createElement('div');
      div.style.cssText = 'width:560px;height:420px;display:inline-block';
      host.appendChild(div);
      return div;
    };
    const failures = [];
    let sampled = 0;
    for (const [name, values] of Object.entries(fixtures)) {
      for (const variant of variants) {
        const options = { ...definition.defaultOptions, ...variant };
        const pageData = [
          { pageId: 'a', pageName: `${name} A`, values, cellCount: values.length, variableInfo },
          { pageId: 'b', pageName: `${name} B`, values: values.map(v => v * 0.75 + 0.5), cellCount: values.length, variableInfo },
        ];
        const fresh = definition.buildTraces(pageData, options, null);
        sampled += fresh.filter(trace => trace.histfunc === 'sum').length;
        // The raw-value trace this module built before the bins were sampled.
        const raw = fresh.map((trace, index) => {
          const copy = { ...trace };
          delete copy.y;
          delete copy.histfunc;
          copy.x = Array.from(pageData[index].values).filter(Number.isFinite);
          return copy;
        });
        const layout = definition.buildLayout(pageData, options);
        const label = `${name} ${JSON.stringify(variant)}`;
        const divs = [box(), box()];
        await Plotly.newPlot(divs[0], fresh, structuredClone(layout), getPlotlyConfig());
        await Plotly.newPlot(divs[1], raw, structuredClone(layout), getPlotlyConfig());
        const [mine, theirs] = divs;
        for (let t = 0; t < theirs.calcdata.length; t++) {
          const a = mine.calcdata[t];
          const b = theirs.calcdata[t];
          if (a.length !== b.length) {
            failures.push(`${label} trace ${t} draws ${a.length} bars vs ${b.length}`);
            continue;
          }
          for (let k = 0; k < b.length; k++) {
            for (const key of ['p', 's', 'b', 'ph0', 'ph1', 'width1']) {
              if (!Object.is(a[k][key], b[k][key])) failures.push(`${label} trace ${t} bar ${k} ${key}: ${a[k][key]} vs ${b[k][key]}`);
            }
          }
        }
        for (const axis of ['xaxis', 'yaxis']) {
          const ra = JSON.stringify(mine._fullLayout[axis].range);
          const rb = JSON.stringify(theirs._fullLayout[axis].range);
          if (ra !== rb) failures.push(`${label} ${axis} range ${ra} vs ${rb}`);
        }
        const geometry = div => [...div.querySelectorAll('.barlayer path')].map(node => node.getAttribute('d'));
        if (JSON.stringify(geometry(mine)) !== JSON.stringify(geometry(theirs))) failures.push(`${label} bar geometry differs`);
        const hoverText = div => {
          const bar = div.calcdata[0][Math.floor(div.calcdata[0].length / 2)];
          const xa = div._fullLayout.xaxis;
          const ya = div._fullLayout.yaxis;
          Plotly.Fx.hover(div, { xpx: xa.c2p(bar.p), ypx: ya.c2p(bar.s / 2) });
          const text = [...div.querySelectorAll('.hoverlayer text')].map(node => node.textContent).sort();
          Plotly.Fx.unhover(div);
          return text;
        };
        const ha = hoverText(mine);
        const hb = hoverText(theirs);
        if (JSON.stringify(ha) !== JSON.stringify(hb)) failures.push(`${label} hover ${JSON.stringify(ha)} vs ${JSON.stringify(hb)}`);
        if (hb.length === 0) failures.push(`${label} hover produced no text`);
        for (const div of divs) { Plotly.purge(div); div.remove(); }
      }
    }
    return { failures, sampled };
  });
  expect(report.failures).toEqual([]);
  expect(report.sampled, 'the fixtures must exercise the sampled path').toBeGreaterThan(30);
});
