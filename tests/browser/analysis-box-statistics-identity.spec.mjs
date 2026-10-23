/**
 * A box plot that draws points hands Plotly precomputed statistics and only the
 * drawn points (assets/js/app/analysis/plots/plotly-box-statistics.js) instead
 * of every value. This spec draws each fixture twice in the real engine — once
 * through the application's box definition, once as the raw-value trace it
 * used to build — and requires the same calcdata (every statistic compared with
 * `Object.is`, every drawn point), the same box, whisker and point geometry,
 * the same autorange and the same hover text. Outliers are drawn without
 * jitter, so identical outliers land on one spot and the application draws at
 * most `COINCIDENT_OUTLIER_COPIES` of them: its points are the raw trace's
 * points with every run of an identical outlier cut to that many copies. The
 * application's points are drawn by the point layer (one image per box,
 * plots/point-layer.js) from the positions Plotly lays out, so they are read
 * from the calcdata and mapped through the axes, where the raw trace's are
 * read from its SVG paths.
 */
import { expect, test } from './helpers/test.mjs';
import { openPlotHarness } from './helpers/plot-harness.mjs';


test('precomputed box statistics draw exactly the raw-value box', async ({ page }) => {
  await openPlotHarness(page);
  const report = await page.evaluate(async () => {
    const definition = (await import('/assets/js/app/analysis/plots/types/boxplot.js')).default;
    const { COINCIDENT_OUTLIER_COPIES } = await import('/assets/js/app/analysis/plots/plotly-box-statistics.js');
    // The raw trace's drawn points, every run of an identical outlier cut to
    // the copies the application draws. Jittered points ('all') are spread
    // apart and all drawn.
    const capped = (points, values, jittered) => {
      if (jittered) return points;
      const kept = [];
      let run = 0;
      for (let i = 0; i < points.length; i++) {
        run = i > 0 && values[i] === values[i - 1] ? run + 1 : 0;
        if (run < COINCIDENT_OUTLIER_COPIES) kept.push(points[i]);
      }
      return kept;
    };
    const { createMinimalPlotly, getPlotlyConfig } = await import('/assets/js/app/analysis/plots/plot-base.js');
    const Plotly = await createMinimalPlotly();

    let state = 2024;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const normal = () => Math.sqrt(-2 * Math.log(Math.max(random(), 1e-12))) * Math.cos(2 * Math.PI * random());
    const fixtures = {
      quantized: Float32Array.from({ length: 30000 }, () => (
        random() < 0.65 ? 0 : Math.fround(Math.round(Math.exp(normal() * 0.6 + 0.5) * 40) / 40)
      )),
      continuous: Float32Array.from({ length: 20000 }, () => Math.fround(normal() * 3 + 1)),
      // Quartiles all zero: every expressing cell is an outlier, in runs far
      // longer than the drawn copies.
      zeroInflated: Float32Array.from({ length: 40000 }, () => (
        random() < 0.85 ? 0 : Math.fround(Math.round(random() * 12) / 4)
      )),
      signedZeros: Float32Array.from({ length: 4001 }, (_, i) => (
        i % 3 === 0 ? -0 : i % 3 === 1 ? 0 : Math.fround(normal())
      )),
      tiny: Float32Array.of(5),
      pair: Float32Array.of(2, -7),
    };
    const variableInfo = { key: 'G', name: 'G', kind: 'continuous' };
    const variants = [
      { showPoints: 'outliers' },
      { showPoints: 'all', jitter: 40 },
      { showPoints: 'outliers', showMean: true },
      { showPoints: 'outliers', notched: true },
      { showPoints: 'none' },
      { showPoints: 'outliers', orientation: 'horizontal' },
    ];
    const statKeys = ['pos', 'min', 'max', 'q1', 'med', 'q3', 'lf', 'uf', 'mean', 'lo', 'uo', 'ln', 'un'];
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
    let precomputedTraces = 0;
    // The drawn points of a calcdata entry as [value, x, y]: Plotly's records,
    // or the typed arrays the point layer keeps for a box of every value.
    const drawnOf = entry => {
      if (!entry._cellucidPos) return entry.pts2.map(p => [p.v, p.x, p.y]);
      const horizontal = entry.trace?.orientation === 'h';
      return Array.from(entry._cellucidVals, (v, k) => (
        horizontal ? [v, v, entry._cellucidPos[k]] : [v, entry._cellucidPos[k], v]
      ));
    };
    let cappedStacks = 0;
    for (const [name, values] of Object.entries(fixtures)) {
      for (const variant of variants) {
        const options = { ...definition.defaultOptions, ...variant };
        const pageData = [
          { pageId: 'a', pageName: `${name} A`, values, cellCount: values.length, variableInfo },
          { pageId: 'b', pageName: `${name} B`, values: values.map(v => v * 0.5 + 0.25), cellCount: values.length, variableInfo },
        ];
        const fresh = definition.buildTraces(pageData, options, null);
        const precomputed = fresh.filter(trace => Array.isArray(trace.q1)).length;
        if ((variant.showPoints === 'none' || variant.notched) && precomputed > 0) {
          failures.push(`${name} ${JSON.stringify(variant)} must hand Plotly the values`);
        }
        precomputedTraces += precomputed;
        // The raw-value trace this module built before statistics were precomputed.
        const raw = fresh.map((trace, index) => {
          const copy = { ...trace };
          for (const key of ['q1', 'median', 'q3', 'lowerfence', 'upperfence', 'mean', 'sd', 'notchspan']) delete copy[key];
          // Plotly's own SVG points.
          delete copy._cellucidPointLayer;
          const numeric = Array.from(pageData[index].values).filter(Number.isFinite);
          const vertical = options.orientation !== 'horizontal';
          copy[vertical ? 'y' : 'x'] = numeric;
          copy[vertical ? 'x' : 'y'] = new Array(numeric.length).fill(trace.name);
          return copy;
        });
        const layout = definition.buildLayout(pageData, options);
        const label = `${name} ${JSON.stringify(variant)}`;
        const divs = [box(), box()];
        await Plotly.newPlot(divs[0], fresh, structuredClone(layout), getPlotlyConfig());
        await Plotly.newPlot(divs[1], raw, structuredClone(layout), getPlotlyConfig());
        const [mine, theirs] = divs;
        for (let t = 0; t < theirs.calcdata.length; t++) {
          const a = mine.calcdata[t][0];
          const b = theirs.calcdata[t][0];
          if (!Array.isArray(a.pts2) || !Array.isArray(b.pts2)) {
            failures.push(`${label} trace ${t} has no calcdata (mine ${Object.keys(a)}; raw ${Object.keys(b)})`);
            continue;
          }
          // Raw-value mode leaves `sd` NaN unless the mean ± σ marker is
          // drawn; precomputed mode always carries it. It is read only for
          // that marker and its hover row.
          for (const key of options.showMean ? [...statKeys, 'sd'] : statKeys) {
            if (!Object.is(a[key], b[key])) failures.push(`${label} trace ${t} ${key}: ${a[key]} vs ${b[key]}`);
          }
          // A raw-value box (no points, or notched) is drawn by Plotly from
          // every value, uncapped.
          const uncapped = options.showPoints === 'all' || !Array.isArray(fresh[t].q1);
          const pa = drawnOf(a);
          const pb = capped(b.pts2.map(p => [p.v, p.x, p.y]), b.pts2.map(p => p.v), uncapped);
          if (JSON.stringify(pa) !== JSON.stringify(pb)) failures.push(`${label} trace ${t} drawn points differ (${pa.length} vs ${pb.length})`);
          if (b.pts2.length > pb.length) cappedStacks++;
        }
        for (const axis of ['xaxis', 'yaxis']) {
          const ra = JSON.stringify(mine._fullLayout[axis].range);
          const rb = JSON.stringify(theirs._fullLayout[axis].range);
          if (ra !== rb) failures.push(`${label} ${axis} range ${ra} vs ${rb}`);
        }
        // Box, whisker and mean paths; the drawn points are compared below.
        const geometry = div => [...div.querySelectorAll('.boxlayer path:not(.point)')].map(node => node.getAttribute('d') ?? node.getAttribute('transform'));
        if (JSON.stringify(geometry(mine)) !== JSON.stringify(geometry(theirs))) failures.push(`${label} box geometry differs`);
        // Point elements are drawn trace by trace, in drawn-point order: the
        // raw trace's SVG translations, and the axis pixels of the layer's.
        const points = div => [...div.querySelectorAll('.boxlayer .trace')].flatMap((node, t) => {
          const drawn = [...node.querySelectorAll('.point')].map(point => point.getAttribute('transform'));
          const uncapped = options.showPoints === 'all' || !Array.isArray(fresh[t].q1);
          return capped(drawn, div.calcdata[t][0].pts2.map(p => p.v), uncapped);
        });
        // A box without points keeps its outliers' records but draws none.
        const layerPoints = div => (options.showPoints === 'none' ? [] : div.calcdata).flatMap(cd => drawnOf(cd[0]).map(([, x, y]) => (
          `translate(${div._fullLayout.xaxis.c2p(x)},${div._fullLayout.yaxis.c2p(y)})`
        )));
        if (mine.querySelector('.boxlayer path.point')) failures.push(`${label} draws SVG points`);
        if (JSON.stringify(layerPoints(mine)) !== JSON.stringify(points(theirs))) failures.push(`${label} point geometry differs`);
        const hoverText = div => {
          const vertical = options.orientation !== 'horizontal';
          const positionAxis = div._fullLayout[vertical ? 'xaxis' : 'yaxis'];
          const valueAxis = div._fullLayout[vertical ? 'yaxis' : 'xaxis'];
          const along = positionAxis.c2p(div.calcdata[0][0].pos);
          const box = div.calcdata[0][0];
          const across = valueAxis.c2p((box.med + box.q3) / 2 + (box.uf - box.lf) * 0.05);
          Plotly.Fx.hover(div, vertical ? { xpx: along, ypx: across } : { xpx: across, ypx: along });
          const text = [...div.querySelectorAll('.hoverlayer text')].map(node => node.textContent).sort();
          Plotly.Fx.unhover(div);
          return text;
        };
        const ha = hoverText(mine);
        const hb = hoverText(theirs);
        if (JSON.stringify(ha) !== JSON.stringify(hb)) failures.push(`${label} hover ${JSON.stringify(ha)} vs ${JSON.stringify(hb)}`);
        // A box whose quartiles coincide has no body to hover.
        const body = theirs.calcdata[0][0];
        if (hb.length === 0 && body.q3 > body.q1) failures.push(`${label} hover produced no text`);
        for (const div of divs) { Plotly.purge(div); div.remove(); }
      }
    }
    return { failures, precomputedTraces, cappedStacks };
  });
  expect(report.failures).toEqual([]);
  expect(report.precomputedTraces, 'the fixtures must exercise the precomputed path').toBeGreaterThan(30);
  expect(report.cappedStacks, 'the fixtures must exercise the outlier cap').toBeGreaterThan(0);
});
