/**
 * A large page's box statistics and drawn points are computed by an analysis
 * worker before the box plot is drawn. This spec renders the application's
 * box definition in the real engine for pages large enough to take the worker
 * path and requires the drawn calcdata — every statistic and every drawn point,
 * compared with `Object.is` — to equal what the one-thread trace builder
 * draws for the same values.
 */
import { expect, test } from './helpers/test.mjs';
import { openPlotHarness } from './helpers/plot-harness.mjs';


test('worker-computed box statistics draw exactly the one-thread box', async ({ page }) => {
  await openPlotHarness(page);
  const report = await page.evaluate(async () => {
    const host = document.getElementById('plot-host');
    host.style.width = '1200px';
    host.style.height = '440px';
    let state = 4242;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const normal = () => Math.sqrt(-2 * Math.log(Math.max(random(), 1e-12))) * Math.cos(2 * Math.PI * random());
    const quantized = Float32Array.from({ length: 150000 }, () => (
      random() < 0.8 ? 0 : Math.fround(Math.round(random() * 254) / 60)
    ));
    const continuous = Float32Array.from({ length: 160000 }, () => Math.fround(normal() * 2 + 1));
    continuous[11] = NaN;
    const variableInfo = { key: 'G', name: 'G', kind: 'continuous' };
    const definition = (await import('/assets/js/app/analysis/plots/types/boxplot.js')).default;
    const { getComputeManager } = await import('/assets/js/app/analysis/compute/compute-manager.js');
    const manager = getComputeManager();
    const execute = manager.execute.bind(manager);
    let dispatched = 0;
    manager.execute = (operation, ...rest) => {
      if (operation === 'COMPUTE_BOX_STATISTICS') dispatched++;
      return execute(operation, ...rest);
    };
    const statKeys = ['pos', 'min', 'max', 'q1', 'med', 'q3', 'lf', 'uf', 'mean', 'sd', 'lo', 'uo', 'ln', 'un'];
    const results = [];
    for (const variant of [{ showPoints: 'outliers' }, { showPoints: 'all' }, { showPoints: 'outliers', showMean: true }]) {
      const options = { ...definition.defaultOptions, ...variant };
      // Fresh arrays per variant: a computed box is kept per values array.
      const pageData = [
        { pageId: 'q', pageName: 'Q', values: quantized.slice(), cellCount: quantized.length, variableInfo },
        { pageId: 'c', pageName: 'C', values: continuous.slice(), cellCount: continuous.length, variableInfo },
      ];
      const mine = document.createElement('div');
      const theirs = document.createElement('div');
      for (const div of [mine, theirs]) {
        div.style.cssText = 'width:560px;height:420px;display:inline-block';
        host.appendChild(div);
      }
      const before = dispatched;
      await definition.render(pageData, options, mine, null);
      const workerPages = dispatched - before;
      // Fresh arrays carry no worker result, so these traces are built here.
      const fresh = pageData.map(pd => ({ ...pd, values: pd.values.slice() }));
      await window.Plotly.newPlot(
        theirs,
        definition.buildTraces(fresh, options, null),
        definition.buildLayout(fresh, options),
        { staticPlot: false }
      );
      let mismatches = 0;
      const detail = [];
      for (let t = 0; t < theirs.calcdata.length; t++) {
        const a = mine.calcdata[t][0];
        const b = theirs.calcdata[t][0];
        for (const key of statKeys) {
          if (!Object.is(a[key], b[key])) {
            mismatches++;
            detail.push(`${t} ${key} ${a[key]} vs ${b[key]}`);
          }
        }
        const pa = JSON.stringify(a.pts2.map(p => p.v));
        const pb = JSON.stringify(b.pts2.map(p => p.v));
        if (pa !== pb) {
          mismatches++;
          detail.push(`${t} points ${a.pts2.length} vs ${b.pts2.length}`);
        }
      }
      results.push({
        variant: JSON.stringify(variant),
        workerPages,
        backend: manager.getStatus().worker.status,
        mismatches,
        detail: detail.slice(0, 5),
      });
      window.Plotly.purge(mine);
      window.Plotly.purge(theirs);
      mine.remove();
      theirs.remove();
    }
    delete manager.execute;
    return results;
  });
  for (const result of report) {
    expect(result.backend, 'the analysis workers are available').toBe('available');
    expect(result.workerPages, `${result.variant}: both pages were computed by workers`).toBe(2);
    expect(result.mismatches, `${result.variant} ${result.detail.join('; ')}`).toBe(0);
  }
});
