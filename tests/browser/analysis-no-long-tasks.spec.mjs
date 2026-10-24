/**
 * The analysis engine keeps the page responsive: a marker genes run and a
 * differential expression over every gene of a 20 000-cell dataset never
 * block the main thread, the dataset's first gene read included. Chromium
 * reports long tasks (over 50 ms) directly; Firefox and WebKit have no long
 * task API and are held to the same bound by a heartbeat: a zero-delay timer
 * re-armed from itself, whose longest wait is the longest the main thread
 * was held.
 *
 * Not the gap between animation frames: a frame also waits for the
 * compositor, which is not the main thread. Linux WebKit composites in
 * software, at the Desktop Safari device's scale factor of 2; there frames
 * came 106 and 461 ms apart during these runs, while Chromium on the same
 * runners reported no long task for the same flows. The frame gap is still
 * reported with a failure, beside the heartbeat. The dataset is read over
 * HTTP, not through `page.route` (`helpers/served-fixture.mjs` says why).
 *
 * The run starts once the scene is quiet (`sceneQuietness`), and draws no
 * frame of its own. On Linux WebKit a frame holds the main thread about as
 * long as the frame gap above, so a run started while the viewer still owed
 * the frames of the dataset's opening (its studio fade and settle frames)
 * measured one of them: the heartbeat held 459 ms with frames 457 ms apart,
 * while the run itself draws nothing and changes no DOM (measured in WebKit
 * and Chromium on macOS: no draw call and no mutation during either run).
 */
import { expect, test } from './helpers/test.mjs';
import { anndataZarrZip } from './helpers/anndata-zarr-zip.mjs';
import { writeServedFixture } from './helpers/served-fixture.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { sceneQuietness } from './helpers/frame-scheduling.mjs';

const DATASET = 'analysis-responsive';
const CELLS = 20_000;
const GROUPS = Array.from({ length: 8 }, (_, group) => `cluster ${group}`);
const GENES = Array.from({ length: 200 }, (_, gene) => `GENE${gene}`);
/** A long task, as the Long Tasks API counts one. */
const MAIN_THREAD_BUDGET_MS = 50;

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
    let running = true;
    let startedAt = performance.now();
    // The viewer's draw calls during the run: a run draws no frame.
    const gl = window._cellucidViewer.getGLContext();
    let draws = 0;
    const drawNames = ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced'];
    for (const name of drawNames) {
      const original = gl[name];
      gl[name] = function countedDraw(...args) {
        draws += 1;
        return Reflect.apply(original, this, args);
      };
    }
    // The main thread: the longest wait of a timer that re-arms itself at
    // once, and when in the run it began.
    let heldMs = 0;
    let heldAt = 0;
    let lastBeat = performance.now();
    const beat = () => {
      const now = performance.now();
      if (now - lastBeat > heldMs) {
        heldMs = now - lastBeat;
        heldAt = lastBeat - startedAt;
      }
      lastBeat = now;
      if (running) setTimeout(beat, 0);
    };
    setTimeout(beat, 0);
    // The frames, reported with a failure only (see the header).
    let frameGapMs = 0;
    let lastFrame = performance.now();
    const frame = now => {
      frameGapMs = Math.max(frameGapMs, now - lastFrame);
      lastFrame = now;
      if (running) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    // Let the page settle before the run starts.
    await new Promise(resolve => setTimeout(resolve, 200));
    startedAt = performance.now();
    heldMs = 0;
    heldAt = 0;
    lastBeat = startedAt;
    frameGapMs = 0;
    lastFrame = startedAt;
    draws = 0;

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
    // A hold that ends the run has no beat after it: the run's end is one.
    beat();
    running = false;
    observer?.disconnect();
    for (const name of drawNames) delete gl[name];
    return {
      genes,
      longTasks,
      measuredLongTasks: observer !== null,
      heldMs: Math.round(heldMs),
      heldAtMs: Math.round(heldAt),
      runMs: Math.round(performance.now() - startedAt),
      frameGapMs: Math.round(frameGapMs),
      draws,
      budget,
    };
  }, { flowName: flow, budget: MAIN_THREAD_BUDGET_MS });
}

for (const flow of ['markers', 'differential']) {
  test(`a ${flow} run over every gene never holds the main thread`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(`/?sampleCatalog=${encodeURIComponent(served.root)}&dataset=${DATASET}`, { waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    await page.waitForFunction(count => window._comparisonModule?.state?.pointCount === count, CELLS, { timeout: 120_000 });
    // The frames the opening owes are drawn before the run, not during it.
    await expect.poll(() => sceneQuietness(page), { timeout: 120_000 }).toBe('quiet');
    const result = await measure(page, flow);
    expect(result.genes).toBe(GENES.length);
    expect(result.draws, `draw calls during the ${flow} run: ${JSON.stringify(result)}`).toBe(0);
    if (result.measuredLongTasks) {
      expect(result.longTasks, `long tasks during the ${flow} run (ms)`).toEqual([]);
    } else {
      expect(
        result.heldMs,
        `longest the main thread was held during the ${flow} run (ms): ${JSON.stringify(result)}`,
      ).toBeLessThanOrEqual(MAIN_THREAD_BUDGET_MS);
    }
  });
}
