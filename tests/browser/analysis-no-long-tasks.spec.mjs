/**
 * The analysis engine keeps the page responsive: a marker genes run and a
 * differential expression over every gene of a 20 000-cell dataset never
 * block the main thread, the dataset's first gene read included. Chromium
 * reports long tasks (over 50 ms) directly; Firefox and WebKit are held to
 * the same bound by the longest gap between animation frames. The dataset
 * is read over HTTP, not through `page.route` (`helpers/served-fixture.mjs`
 * says why).
 */
import { expect, test } from './helpers/test.mjs';
import { anndataZarrZip } from './helpers/anndata-zarr-zip.mjs';
import { writeServedFixture } from './helpers/served-fixture.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET = 'analysis-responsive';
const CELLS = 20_000;
const GROUPS = Array.from({ length: 8 }, (_, group) => `cluster ${group}`);
const GENES = Array.from({ length: 200 }, (_, gene) => `GENE${gene}`);
const FRAME_BUDGET_MS = 50;

function fixture() {
  const codes = Int8Array.from({ length: CELLS }, (_, cell) => cell % GROUPS.length);
  const X = new Float32Array(CELLS * GENES.length);
  let state = 12345;
  const random = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 4294967296;
  };
  for (let cell = 0; cell < CELLS; cell++) {
    for (let gene = 0; gene < GENES.length; gene++) {
      const marker = gene % GROUPS.length === codes[cell];
      const r = random();
      X[cell * GENES.length + gene] = r < 0.6 ? 0 : Math.round((marker ? 2 : 0.5) * r * 8) / 4;
    }
  }
  return anndataZarrZip({
    cells: CELLS,
    genes: [...GENES],
    X,
    obs: { cluster: { categories: [...GROUPS], codes } },
    obsm: {
      X_umap: { data: Float32Array.from({ length: CELLS * 2 }, (_, i) => Math.sin(i * 0.37) * 4), columns: 2 },
    },
    uns: { cellucid: { schema: 1, id: DATASET, name: 'Responsiveness fixture' } },
  });
}

let served = null;

test.beforeAll(() => {
  const file = `${DATASET}.zarr.zip`;
  served = writeServedFixture(DATASET, {
    'datasets.json': JSON.stringify({ schema: 2, default: DATASET, datasets: [{ id: DATASET, path: file }] }),
    [file]: fixture(),
  });
});

test.afterAll(() => served?.remove());

function observeProductErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

/** Run `flow` in the page while measuring how long the main thread was held. */
async function measure(page, flow) {
  return page.evaluate(async ({ flowName, budget }) => {
    const cm = window._comparisonModule;
    const longTasks = [];
    let observer = null;
    if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) longTasks.push(Math.round(entry.duration));
      });
      observer.observe({ type: 'longtask' });
    }
    let maxGap = 0;
    let last = performance.now();
    let running = true;
    const tick = now => {
      maxGap = Math.max(maxGap, now - last);
      last = now;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // Let the frame loop settle before the run starts.
    await new Promise(resolve => setTimeout(resolve, 200));
    maxGap = 0;
    last = performance.now();

    let genes = 0;
    if (flowName === 'markers') {
      const { GenesPanelController } = await import('/assets/js/app/analysis/genes-panel/genes-panel-controller.js');
      const { MARKER_OPTIONS } = await import('/assets/js/app/analysis/options/marker-options.js');
      const controller = new GenesPanelController({ dataLayer: cm.dataLayer });
      try {
        const options = MARKER_OPTIONS.withDefaults({ groupBy: 'cluster' }, { categoricalFields: [{ key: 'cluster' }] });
        const run = await controller.runAnalysis({ options });
        genes = run.metadata.geneCount;
      } finally {
        controller.close();
      }
    } else {
      const codes = (await cm.dataLayer.ensureObsFieldLoaded('cluster', { silent: true })).codes;
      const cellsOf = code => Uint32Array.from([...codes.keys()].filter(cell => codes[cell] === code));
      const result = await cm.multiVariableAnalysis.differentialExpression({
        groupA: { name: 'cluster 0', cells: cellsOf(0) },
        groupB: { name: 'cluster 1', cells: cellsOf(1) },
        method: 'wilcox',
      });
      genes = result.summary.genesTested;
    }
    running = false;
    observer?.disconnect();
    return { genes, longTasks, maxGap: Math.round(maxGap), measuredLongTasks: observer !== null, budget };
  }, { flowName: flow, budget: FRAME_BUDGET_MS });
}

for (const flow of ['markers', 'differential']) {
  test(`a ${flow} run over every gene never holds the main thread`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(`/?sampleCatalog=${encodeURIComponent(served.root)}&dataset=${DATASET}`, { waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    await page.waitForFunction(count => window._comparisonModule?.state?.pointCount === count, CELLS, { timeout: 120_000 });
    const result = await measure(page, flow);
    expect(result.genes).toBe(GENES.length);
    if (result.measuredLongTasks) {
      expect(result.longTasks, `long tasks during the ${flow} run (ms)`).toEqual([]);
    } else {
      expect(result.maxGap, `longest gap between frames during the ${flow} run (ms)`).toBeLessThanOrEqual(FRAME_BUDGET_MS);
    }
  });
}
