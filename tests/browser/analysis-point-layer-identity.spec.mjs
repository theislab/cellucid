/**
 * Box and violin points are drawn as one image per box or violin
 * (assets/js/app/analysis/plots/point-layer.js) from the positions Plotly's own
 * point loop lays out (the vendored bundle's `cellucidPointLayer`). This spec
 * draws each fixture twice in the real engine -- once through the application's
 * definitions, once as the same traces without the point layer, which Plotly
 * draws as one SVG path per point -- and requires every point at the same
 * position (data coordinates compared with `Object.is`, and the SVG path's
 * pixel translation equal to the axis `c2p` of the layer's position), the same
 * hovered point and hover text, an image in each points group instead of
 * paths, and that image in an SVG export.
 */
import { expect, test } from './helpers/test.mjs';
import { openPlotHarness } from './helpers/plot-harness.mjs';

test('the point layer draws every point where Plotly puts it, with the same hover', async ({ page }) => {
  test.setTimeout(240_000);
  await openPlotHarness(page);
  const report = await page.evaluate(async () => {
    const box = (await import('/assets/js/app/analysis/plots/types/boxplot.js')).default;
    const violin = (await import('/assets/js/app/analysis/plots/types/violinplot.js')).default;
    const { createMinimalPlotly, getPlotlyConfig } = await import('/assets/js/app/analysis/plots/plot-base.js');
    const Plotly = await createMinimalPlotly();

    let state = 77;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const normal = () => Math.sqrt(-2 * Math.log(Math.max(random(), 1e-12))) * Math.cos(2 * Math.PI * random());
    const fixtures = {
      quantized: Float32Array.from({ length: 6000 }, () => (
        random() < 0.6 ? 0 : Math.fround(Math.round(Math.exp(normal() * 0.6 + 0.5) * 40) / 40)
      )),
      continuous: Float32Array.from({ length: 5000 }, () => Math.fround(normal() * 3 + 1)),
      constant: new Float32Array(300).fill(2),
      // Large enough for the violin's precomputed calc (typed points).
      large: Float32Array.from({ length: 120000 }, () => (
        random() < 0.7 ? 0 : Math.fround(Math.exp(normal() * 0.8))
      )),
    };
    const variableInfo = { key: 'G', name: 'G', kind: 'continuous' };
    const cases = [
      [box, { showPoints: 'all', jitter: 40 }],
      [box, { showPoints: 'all', jitter: 0 }],
      [box, { showPoints: 'all', jitter: 70, orientation: 'horizontal' }],
      [box, { showPoints: 'all', jitter: 30, notched: true }],
      // Zeros have no pixel on a log axis: Plotly leaves their paths
      // untranslated and never hovers them; the layer draws none of them.
      [box, { showPoints: 'all', jitter: 40, logScale: true }],
      [box, { showPoints: 'outliers' }],
      [violin, { showPoints: 'all' }],
      [violin, { showPoints: 'outliers' }],
    ];
    const host = document.getElementById('plot-host');
    const failures = [];
    const counts = { points: 0, typed: 0, records: 0, hovers: 0 };
    const translateOf = node => (node.getAttribute('transform') ?? 'translate(NaN,NaN)').match(/translate\(([^,]+),([^)]+)\)/).slice(1).map(Number);

    for (const [definition, variant] of cases) {
      for (const [name, values] of Object.entries(fixtures)) {
        const label = `${definition.id} ${name} ${JSON.stringify(variant)}`;
        const options = { ...definition.defaultOptions, ...variant };
        const pageData = [
          { pageId: 'a', pageName: `${name} A`, values, cellCount: values.length, variableInfo },
          { pageId: 'b', pageName: `${name} B`, values: values.map(v => v * 0.5 + 0.25), cellCount: values.length, variableInfo },
        ];
        const divs = [0, 1].map(() => {
          const div = document.createElement('div');
          div.style.cssText = 'width:600px;height:420px;display:inline-block';
          host.appendChild(div);
          return div;
        });
        const [mine, theirs] = divs;
        await definition.render(pageData, options, mine, null);
        const reference = mine.data.map(({ _cellucidPointLayer, _precomputedViolin, ...trace }) => trace);
        await Plotly.newPlot(theirs, reference, structuredClone(mine.layout), getPlotlyConfig());

        for (let t = 0; t < theirs.calcdata.length; t++) {
          const a = mine.calcdata[t][0];
          const b = theirs.calcdata[t][0];
          const horizontal = options.orientation === 'horizontal';
          const posKey = horizontal ? 'y' : 'x';
          const valKey = horizontal ? 'x' : 'y';
          // The layer's points: typed arrays, or Plotly's records it laid out.
          let positions;
          let drawnValues;
          if (a._cellucidPos) {
            positions = Array.from(a._cellucidPos);
            drawnValues = Array.from(a._cellucidVals);
            counts.typed++;
          } else {
            positions = a.pts2.map(p => p[posKey]);
            drawnValues = a.pts2.map(p => p.v);
            counts.records++;
          }
          const expectedPositions = b.pts2.map(p => p[posKey]);
          const expectedValues = b.pts2.map(p => p[valKey]);
          if (positions.length !== expectedPositions.length) {
            failures.push(`${label} trace ${t}: ${positions.length} vs ${expectedPositions.length} points`);
            continue;
          }
          for (let k = 0; k < positions.length; k++) {
            if (!Object.is(positions[k], expectedPositions[k]) || !Object.is(drawnValues[k], expectedValues[k])) {
              failures.push(`${label} trace ${t} point ${k}: (${positions[k]}, ${drawnValues[k]}) vs (${expectedPositions[k]}, ${expectedValues[k]})`);
              break;
            }
          }
          counts.points += positions.length;
          // Plotly's SVG translation of each point is the axis c2p of the position.
          const xa = theirs._fullLayout.xaxis;
          const ya = theirs._fullLayout.yaxis;
          const paths = [...theirs.querySelectorAll('.trace')[t].querySelectorAll('path.point')];
          for (let k = 0; k < paths.length; k += Math.max(1, Math.floor(paths.length / 200))) {
            const [x, y] = translateOf(paths[k]);
            const px = xa.c2p(horizontal ? drawnValues[k] : positions[k]);
            const py = ya.c2p(horizontal ? positions[k] : drawnValues[k]);
            const placed = Number.isFinite(px) && Number.isFinite(py);
            if (placed ? (x !== px || y !== py) : Number.isFinite(x)) {
              failures.push(`${label} trace ${t} pixel ${k}: (${px}, ${py}) vs (${x}, ${y})`);
              break;
            }
          }
          const group = mine.querySelectorAll('.trace')[t].querySelector('g.points');
          if (group?.querySelector('path.point')) failures.push(`${label} trace ${t} still draws SVG points`);
          const image = group?.querySelector('image.cellucid-points');
          if (positions.length > 0 && !(image?.getAttribute('xlink:href') ?? image?.getAttribute('href') ?? '').startsWith('data:image/png')) {
            failures.push(`${label} trace ${t} has no point image`);
          }

          // Hover on points and between them: the same nearest point and the
          // same label, wherever the cursor is.
          const probes = [];
          for (let q = 0; q < 24 && positions.length > 0; q++) {
            const k = Math.floor(random() * positions.length);
            probes.push([
              xa.c2p(horizontal ? drawnValues[k] : positions[k]) + (random() - 0.5) * 6,
              ya.c2p(horizontal ? positions[k] : drawnValues[k]) + (random() - 0.5) * 6,
            ]);
          }
          for (let q = 0; q < 8; q++) probes.push([random() * xa._length, random() * ya._length]);
          for (const [xpx, ypx] of probes) {
            if (!Number.isFinite(xpx) || !Number.isFinite(ypx)) continue;
            const k = `(${xpx.toFixed(1)}, ${ypx.toFixed(1)})`;
            const read = div => {
              Plotly.Fx.hover(div, { xpx, ypx }, 'xy');
              const data = (div._hoverdata ?? []).map(d => [d.curveNumber, JSON.stringify(d.pointNumber), d[valKey]]);
              const text = [...div.querySelectorAll('.hoverlayer text')].map(node => node.textContent).sort();
              Plotly.Fx.unhover(div);
              return JSON.stringify([data, text]);
            };
            const ha = read(mine);
            const hb = read(theirs);
            counts.hovers++;
            if (ha !== hb) failures.push(`${label} trace ${t} hover at point ${k}: ${ha} vs ${hb}`);
          }
        }
        if (name === 'quantized' && definition === box && variant.jitter === 40) {
          const svg = await Plotly.toImage(mine, { format: 'svg', width: 600, height: 420 });
          if (!decodeURIComponent(svg).includes('data:image/png')) failures.push(`${label} SVG export has no point image`);
        }
        for (const div of divs) { Plotly.purge(div); div.remove(); }
      }
    }
    return { failures, counts };
  });
  expect(report.failures).toEqual([]);
  expect(report.counts.typed, 'typed points are exercised').toBeGreaterThan(0);
  expect(report.counts.records, 'record points are exercised').toBeGreaterThan(0);
  expect(report.counts.points).toBeGreaterThan(100000);
});

test('the volcano draws every gene where and in the colour Plotly would, before and after a threshold change', async ({ page }) => {
  test.setTimeout(120_000);
  await openPlotHarness(page);
  const report = await page.evaluate(async () => {
    const volcano = (await import('/assets/js/app/analysis/plots/types/volcanoplot.js')).default;
    const { createMinimalPlotly, getPlotlyConfig } = await import('/assets/js/app/analysis/plots/plot-base.js');
    const Plotly = await createMinimalPlotly();
    let state = 9;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const results = Array.from({ length: 9000 }, (_, i) => {
      const p = random() < 0.002 ? 0 : Math.pow(random(), 4);
      return {
        gene: `G${i}`,
        log2FoldChange: (random() - 0.5) * 8,
        pValue: p,
        adjustedPValue: Math.min(1, p * 3),
        meanA: random(),
        meanB: random(),
      };
    });
    const host = document.getElementById('plot-host');
    const divs = [0, 1].map(() => {
      const div = document.createElement('div');
      div.style.cssText = 'width:700px;height:520px;display:inline-block';
      host.appendChild(div);
      return div;
    });
    const [mine, theirs] = divs;
    const failures = [];
    const compare = label => {
      const a = mine.calcdata[0];
      const b = theirs.calcdata[0];
      const paths = [...theirs.querySelectorAll('.scatterlayer .trace')[0].querySelectorAll('path.point')];
      // The genes' trace draws no SVG points (the p = 0 triangles stay SVG).
      if (mine.querySelectorAll('.scatterlayer .trace')[0].querySelector('path.point')) failures.push(`${label}: SVG points drawn`);
      const href = mine.querySelector('.scatterlayer .trace image.cellucid-points')?.getAttribute('xlink:href') ?? '';
      if (!href.startsWith('data:image/png')) failures.push(`${label}: no point image`);
      const xa = theirs._fullLayout.xaxis;
      const ya = theirs._fullLayout.yaxis;
      let drawn = 0;
      for (let i = 0; i < b.length; i++) {
        const x = xa.c2p(a[i].x);
        const y = ya.c2p(a[i].y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const path = paths[drawn++];
        const [px, py] = path.getAttribute('transform').match(/translate\(([^,]+),([^)]+)\)/).slice(1).map(Number);
        if (px !== x || py !== y) { failures.push(`${label} gene ${i}: (${x}, ${y}) vs (${px}, ${py})`); break; }
        if (a[i].mcc !== b[i].mcc || a[i].mrc !== b[i].mrc) { failures.push(`${label} gene ${i}: ${a[i].mcc}/${a[i].mrc} vs ${b[i].mcc}/${b[i].mrc}`); break; }
      }
      if (drawn !== paths.length) failures.push(`${label}: ${drawn} drawn genes vs ${paths.length} SVG points`);
      for (const i of [0, 17, 4000]) {
        const xpx = xa.c2p(a[i].x);
        const ypx = ya.c2p(a[i].y);
        const read = div => {
          Plotly.Fx.hover(div, { xpx, ypx }, 'xy');
          const text = [...div.querySelectorAll('.hoverlayer text')].map(node => node.textContent).sort();
          Plotly.Fx.unhover(div);
          return JSON.stringify(text);
        };
        const ha = read(mine);
        const hb = read(theirs);
        if (ha !== hb) failures.push(`${label} hover at gene ${i}: ${ha} vs ${hb}`);
      }
      return href;
    };
    const options = { ...volcano.defaultOptions };
    await volcano.render({ results }, options, mine);
    const reference = () => mine.data.map(({ _cellucidPointLayer, ...trace }) => trace);
    await Plotly.newPlot(theirs, reference(), structuredClone(mine.layout), getPlotlyConfig());
    const before = compare('render');
    // A threshold change recolours the genes (a style-only update).
    const changed = { ...options, pValueThreshold: 0.001, foldChangeThreshold: 2 };
    await volcano.update(mine, { results }, changed);
    await new Promise(resolve => setTimeout(resolve, 300));
    await Plotly.react(theirs, reference(), structuredClone(mine.layout), getPlotlyConfig());
    const after = compare('threshold change');
    if (after === before) failures.push('the point image was not redrawn after the colours changed');
    for (const div of divs) { Plotly.purge(div); div.remove(); }
    return { failures };
  });
  expect(report.failures).toEqual([]);
});
