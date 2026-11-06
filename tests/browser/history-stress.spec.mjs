/**
 * The history stress suite in a real page (`cellucid-private/plans/history-v2.md`
 * §3.15.4, workstream HS; the Node half is `tests/stress/`): on a served
 * synthetic dataset of 1 000 000 cells, it measures
 *
 * - the frames during a camera gesture, a slider drag, a highlight of
 *   ~1 000 000 cells and a marker-genes run, with the history recording as it
 *   does today and with recording bypassed (the dispatcher's recorder set
 *   to none, `setRecorder(null)`, the dispatcher's own interface: no
 *   product switch), alternated three times each so a drift of the machine
 *   reads as noise rather than as a difference;
 * - the State panel's branch graph at 1 000 and 10 000 steps, and at 10 000
 *   steps and 100 branches: the first draw when the panel opens, the frame
 *   of one more step, and scrolling it, each
 *   with Chromium's own counters of where the main thread went (script,
 *   layout, style); and the slider drag again at 10 000 steps, recording as
 *   today against bypassed;
 * - memory (the JS heap after a collection, the history's pool) before and
 *   after 10 000 steps, and what the autosave keeps in IndexedDB.
 *
 * It measures and asserts nothing about the figures: it prints them as one
 * JSON line (`HISTORY-STRESS {…}`) and writes them to the file
 * `CELLUCID_HISTORY_STRESS_OUT` names; `tests/stress/RESULTS.md` records them.
 * It runs only when asked (`CELLUCID_HISTORY_STRESS=1`), in Chromium, on the
 * machine's GPU (`scripts/lib/browser-launch.mjs`): a software rasteriser
 * would make every frame time the rasteriser's. A 1M-cell page is a heavy
 * job: on a 16 GB machine, run it alone (`.cellucid-maintenance/heavy.sh`).
 *
 *   CELLUCID_HISTORY_STRESS=1 npx playwright test tests/browser/history-stress.spec.mjs --project=chromium
 */
import { writeFileSync } from 'node:fs';

import { expect, test } from './helpers/test.mjs';
import { anndataZarrZip } from './helpers/anndata-zarr-zip.mjs';
import { writeServedFixture } from './helpers/served-fixture.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { waitForDatasetReady } from './helpers/dataset-ready.mjs';
import { sceneQuietness } from './helpers/frame-scheduling.mjs';
import { waitForHistory } from './helpers/state-history.mjs';
import { browserLaunchOptions, requireHardwareRenderer } from '../../scripts/lib/browser-launch.mjs';

const ENABLED = process.env.CELLUCID_HISTORY_STRESS === '1';
const OUT = process.env.CELLUCID_HISTORY_STRESS_OUT ?? null;
const DATASET = 'history-stress';
const CELLS = 1_000_000;
const CELL_TYPES = 30;
const GENES = Array.from({ length: 20 }, (_, gene) => `GENE${gene}`);
const OPENING_TIMEOUT_MS = 300_000;
/** Each scenario runs this many times with recording on and as many with it off, alternated. */
const ROUNDS = 3;

test.skip(!ENABLED, 'The history stress spec runs when asked: CELLUCID_HISTORY_STRESS=1 (a 1M-cell page, run alone).');
test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium first: the frame figures are taken on its GPU path.');
test.use({ launchOptions: browserLaunchOptions('chromium') });

/** A 1M-cell dataset: clusters in 2-D, 30 cell types, a sample and two numbers per cell, 20 genes (sparse, ~10%). */
function fixture() {
  let state = 20261104;
  const random = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 4294967296;
  };
  const codes = new Int8Array(CELLS);
  const samples = new Int8Array(CELLS);
  const umap = new Float32Array(CELLS * 2);
  const counts = new Float32Array(CELLS);
  const mito = new Float32Array(CELLS);
  const indptr = new Int32Array(CELLS + 1);
  const indices = [];
  const data = [];
  for (let cell = 0; cell < CELLS; cell++) {
    const type = Math.floor(random() * CELL_TYPES);
    codes[cell] = type;
    samples[cell] = Math.floor(random() * 12);
    const angle = (type / CELL_TYPES) * Math.PI * 2;
    umap[cell * 2] = Math.cos(angle) * 8 + (random() - 0.5) * 2;
    umap[cell * 2 + 1] = Math.sin(angle) * 8 + (random() - 0.5) * 2;
    counts[cell] = 500 + random() * 5000;
    mito[cell] = random() * 20;
    for (let gene = 0; gene < GENES.length; gene++) {
      const marker = gene === type % GENES.length;
      if (random() < (marker ? 0.6 : 0.05)) {
        indices.push(gene);
        data.push(Math.round((marker ? 3 : 0.5) * (0.5 + random()) * 4) / 4);
      }
    }
    indptr[cell + 1] = indices.length;
  }
  return anndataZarrZip({
    cells: CELLS,
    genes: [...GENES],
    X: { data: Float32Array.from(data), indices: Int32Array.from(indices), indptr },
    obs: {
      cell_type: { categories: Array.from({ length: CELL_TYPES }, (_, i) => `type ${i}`), codes },
      sample: { categories: Array.from({ length: 12 }, (_, i) => `sample ${i}`), codes: samples },
      n_counts: counts,
      pct_mito: mito,
    },
    obsm: { X_umap: { data: umap, columns: 2 } },
    uns: { cellucid: { schema: 1, id: DATASET, name: 'History stress (1M cells)' } },
  });
}

let served = null;
const results = { cells: CELLS, rounds: ROUNDS };

test.beforeAll(() => {
  if (!ENABLED) return;
  const file = `${DATASET}.zarr.zip`;
  served = writeServedFixture(DATASET, {
    'datasets.json': JSON.stringify({ schema: 2, default: DATASET, datasets: [{ id: DATASET, path: file }] }),
    [file]: fixture(),
  });
});

test.afterAll(() => {
  served?.remove();
  if (!ENABLED) return;
  const line = JSON.stringify(results);
  console.log(`HISTORY-STRESS ${line}`);
  if (OUT !== null) writeFileSync(OUT, `${JSON.stringify(results, null, 1)}\n`);
});

async function openDataset(page) {
  await page.goto(`/?sampleCatalog=${encodeURIComponent(served.root)}&dataset=${DATASET}`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await waitForDatasetReady(page, CELLS, { timeout: OPENING_TIMEOUT_MS });
  await waitForHistory(page);
  results.renderer = await requireHardwareRenderer(page);
  await expect.poll(() => sceneQuietness(page), { timeout: OPENING_TIMEOUT_MS }).toBe('quiet');
  // The frame probe: every animation frame's interval and every long task while a window is open.
  await page.evaluate(() => {
    let frames = [];
    let longTasks = [];
    let running = false;
    let last = 0;
    new PerformanceObserver(list => {
      if (running) for (const entry of list.getEntries()) longTasks.push(entry.duration);
    }).observe({ type: 'longtask', buffered: false });
    const loop = time => {
      if (!running) return;
      frames.push(time - last);
      last = time;
      requestAnimationFrame(loop);
    };
    const stats = values => {
      const sorted = [...values].sort((a, b) => a - b);
      const at = q => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
      return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? null, total: sorted.reduce((a, b) => a + b, 0) };
    };
    window.__stressProbe = {
      async start() {
        frames = [];
        longTasks = [];
        await new Promise(resolve => requestAnimationFrame(time => { last = time; resolve(); }));
        running = true;
        requestAnimationFrame(loop);
        this.startedAt = performance.now();
      },
      async stop() {
        // The frame that shows the last change is part of the window.
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        running = false;
        return { ms: performance.now() - this.startedAt, frames: stats(frames), longTasks: stats(longTasks) };
      },
    };
  });
}

/** Record with the history (as today) or bypass it (the dispatcher's recorder set to none). */
function setRecording(page, on) {
  return page.evaluate(async recording => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    const history = window._cellucidHistories.current();
    if (recording) {
      getActions().setRecorder(history.recorder);
      // What changed while recording was bypassed is one step, so the next step is only its own.
      await history.reconcile();
    } else {
      getActions().setRecorder(null);
    }
  }, on);
}

async function measured(page, run) {
  await page.evaluate(() => window.__stressProbe.start());
  const value = await run();
  const measured = await page.evaluate(() => window.__stressProbe.stop());
  return { ...measured, ...(value ?? {}) };
}

/** Run `scenario` ROUNDS times with recording on and ROUNDS times off, alternating which goes first. */
async function abTest(page, name, scenario) {
  const out = { on: [], off: [] };
  for (let round = 0; round < ROUNDS; round++) {
    for (const on of round % 2 === 0 ? [true, false] : [false, true]) {
      await setRecording(page, on);
      await expect.poll(() => sceneQuietness(page), { timeout: OPENING_TIMEOUT_MS }).toBe('quiet');
      out[on ? 'on' : 'off'].push(await scenario(round, on));
    }
  }
  await setRecording(page, true);
  results[name] = out;
}

/** A drag of the point-size slider: one input per frame for 120 frames, then its change. */
function sliderDrag(page, round) {
  return measured(page, () => page.evaluate(async start => {
    const slider = document.getElementById('point-size');
    const min = Number(slider.min);
    const max = Number(slider.max);
    for (let i = 0; i < 120; i++) {
      slider.value = String(min + ((start + i) % 60) / 60 * (max - min));
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  }, round * 7));
}

test('recording as today against recording bypassed: a camera gesture, a slider drag, a 1M-cell highlight and an analysis run', async ({ page }) => {
  test.setTimeout(1_800_000);
  await openDataset(page);
  const canvas = await page.locator('#glcanvas').boundingBox();
  const cx = canvas.x + canvas.width / 2;
  const cy = canvas.y + canvas.height / 2;

  await abTest(page, 'cameraGesture', () => measured(page, async () => {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 120; i++) {
      const angle = (i / 120) * Math.PI * 2;
      await page.mouse.move(cx + Math.cos(angle) * 150, cy + Math.sin(angle) * 100);
    }
    await page.mouse.up();
  }));

  await abTest(page, 'sliderDrag', round => sliderDrag(page, round));

  await abTest(page, 'highlightMillion', (round, on) => measured(page, () => page.evaluate(async ({ cells, label }) => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    // Every cell but a scattered thousand: a selection of ~1M cells, its own set each time.
    const drop = new Uint8Array(cells);
    for (let i = 0; i < 1000; i++) drop[(i * 7919 + label.length * 104729 + Math.floor(Math.random() * cells)) % cells] = 1;
    const picked = new Uint32Array(cells);
    let n = 0;
    for (let cell = 0; cell < cells; cell++) if (drop[cell] === 0) picked[n++] = cell;
    const start = performance.now();
    await getActions().dispatch('highlight.cells', { cells: picked.subarray(0, n).slice(), label });
    const dispatchMs = performance.now() - start;
    await getActions().dispatch('highlight.group.remove', { group: label });
    return { dispatchMs };
  }, { cells: CELLS, label: `Stress ${round} ${on ? 'on' : 'off'}` })));

  await page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    await getActions().dispatch('analysis.open', { analysis: 'markers' });
    await getActions().dispatch('analysis.markers.set', { options: { groupBy: 'cell_type' } });
  });
  await abTest(page, 'markersRun', () => measured(page, () => page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    const start = performance.now();
    await getActions().dispatch('analysis.run', { analysis: 'markers' });
    return { dispatchMs: performance.now() - start };
  })));
});

/** The JS heap after a collection (Chromium's DevTools protocol) and the history's pool. */
async function memory(page, cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  const heap = await cdp.send('Runtime.getHeapUsage');
  const facts = await page.evaluate(async () => {
    const history = window._cellucidHistories.current();
    await window._cellucidHistories.flush();
    const estimate = await navigator.storage.estimate();
    return {
      steps: history.trackers().reduce((sum, tree) => sum + tree.steps.size - 1, 0),
      poolValues: history.pool.size, poolBytes: history.pool.byteLength(), storageUsage: estimate.usage ?? null,
    };
  });
  return { heapUsed: heap.usedSize, heapTotal: heap.totalSize, ...facts };
}

/** Take settings steps (two sliders alternating, so no step coalesces) until the history holds `target` steps. */
async function buildSteps(page, target) {
  for (;;) {
    const remaining = await page.evaluate(async goal => {
      const { getActions } = await import('/assets/js/app/actions/index.js');
      const history = window._cellucidHistories.current();
      const count = () => history.active.steps.size - 1;
      const start = count();
      for (let i = 0; i < 500 && count() < goal; i++) {
        const n = start + i;
        const [setting, value] = n % 2 === 0 ? ['point-size', 1 + (n % 40) / 2] : ['lighting-strength', (n % 50) * 2];
        await getActions().dispatch('setting.set', { setting, value });
      }
      return goal - count();
    }, target);
    if (remaining <= 0) return;
  }
}

const METRICS = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount', 'Nodes'];

/** Chromium's own counters of the page's main thread (seconds and counts), so a window's time is attributed. */
async function metrics(cdp) {
  const { metrics: list } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(list.filter(entry => METRICS.includes(entry.name)).map(entry => [entry.name, entry.value]));
}

/** `measure()`'s result with what the main thread spent meanwhile: task, script, layout and style ms; layouts and style passes; DOM nodes after. */
async function attributed(cdp, measure) {
  const before = await metrics(cdp);
  const result = await measure();
  const after = await metrics(cdp);
  const ms = name => Math.round((after[name] - before[name]) * 1000 * 10) / 10;
  return {
    ...result,
    mainThread: {
      taskMs: ms('TaskDuration'), scriptMs: ms('ScriptDuration'), layoutMs: ms('LayoutDuration'), styleMs: ms('RecalcStyleDuration'),
      layouts: after.LayoutCount - before.LayoutCount, styleRecalcs: after.RecalcStyleCount - before.RecalcStyleCount, nodes: after.Nodes,
    },
  };
}

/**
 * The State panel's branch graph (virtualised, History v2 §3.9): its first
 * draw when the panel opens (until the row of the step shown is drawn), the
 * frame of one more step (`addStep`: 'setting', a setting changed through
 * the page's dispatcher; 'stand-in', one appended to the stand-in core), and
 * 120 frames of scrolling it from the top to the end.
 */
async function measureGraph(page, cdp, addStep) {
  const section = page.locator('#state-section');
  await page.evaluate(() => { document.getElementById('state-section').open = false; });
  const open = await attributed(cdp, () => page.evaluate(async () => {
    const section = document.getElementById('state-section');
    const graph = document.getElementById('history-graph');
    await window.__stressProbe.start();
    const start = performance.now();
    section.open = true;
    graph.scrollIntoView({ block: 'center' });
    await new Promise(resolve => {
      const check = () => (graph.querySelector('.hg-row[aria-current="step"]') !== null ? resolve() : requestAnimationFrame(check));
      requestAnimationFrame(check);
    });
    const drawnMs = performance.now() - start;
    const probe = await window.__stressProbe.stop();
    return { rowsDrawn: graph.querySelectorAll('.hg-row').length, drawnMs, ...probe };
  }));
  await expect(section).toHaveAttribute('open', '');
  const oneStep = await attributed(cdp, () => page.evaluate(async how => {
    const graph = document.getElementById('history-graph');
    const head = () => graph.querySelector('.hg-row[aria-current="step"]')?.dataset.key ?? null;
    const before = head();
    await window.__stressProbe.start();
    const start = performance.now();
    if (how === 'stand-in') {
      globalThis.__fakeHistory.append(`One more ${Date.now()}`);
    } else {
      const { getActions } = await import('/assets/js/app/actions/index.js');
      await getActions().dispatch('setting.set', { setting: 'fog-density', value: Math.round(Math.random() * 100) });
    }
    const dispatchMs = performance.now() - start;
    await new Promise(resolve => {
      const check = () => (head() !== before && head() !== null ? resolve() : requestAnimationFrame(check));
      requestAnimationFrame(check);
    });
    const drawnMs = performance.now() - start;
    return { dispatchMs, drawnMs, rowsDrawn: graph.querySelectorAll('.hg-row').length, ...await window.__stressProbe.stop() };
  }, addStep));
  const scroll = await attributed(cdp, () => page.evaluate(async () => {
    const graph = document.getElementById('history-graph');
    graph.scrollTop = 0;
    await window.__stressProbe.start();
    for (let i = 0; i < 120; i++) {
      graph.scrollTop += Math.max(1, (graph.scrollHeight - graph.clientHeight) / 120);
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return { scrollHeight: graph.scrollHeight, rowsDrawn: graph.querySelectorAll('.hg-row').length, ...await window.__stressProbe.stop() };
  }));
  return { open, oneStep, scroll };
}

test('the branch graph and memory at 1 000 and 10 000 steps', async ({ page }) => {
  test.setTimeout(3_600_000);
  await openDataset(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  results.memoryAtStart = await memory(page, cdp);
  results.timeline = {};
  for (const target of [1_000, 10_000]) {
    // Built with the State panel closed (it draws only while shown), then measured open.
    await page.evaluate(() => { document.getElementById('state-section').open = false; });
    const start = Date.now();
    await buildSteps(page, target);
    const buildMs = Date.now() - start;
    results.timeline[target] = {
      buildMs, msPerStepBuilt: buildMs / target,
      ...await measureGraph(page, cdp, 'setting'),
    };
    results[`memoryAt${target}`] = await memory(page, cdp);
  }
  // A slider drag at 10 000 steps, the State panel open as it opens by default: recording as today against bypassed.
  await abTest(page, 'sliderDragAt10k', round => attributed(cdp, () => sliderDrag(page, round)));
});

/**
 * The branch graph at 10 000 steps and 100 branches (History v2 §3.15.4:
 * the graph scrolls at the display's frame rate). The tracker is built of
 * History v2 records (`helpers/history-v2-fake.mjs`): 100 branches of 10
 * steps each, forking from the first 100 steps, and a main line to 10 000
 * steps, a third of them camera moves; one more step is appended as the core
 * appends one.
 */
test('the branch graph at 10 000 steps and 100 branches', async ({ page }) => {
  test.setTimeout(1_800_000);
  await openDataset(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.evaluate(() => { document.getElementById('state-section').open = false; });
  const buildMs = await page.evaluate(async () => {
    const start = performance.now();
    const { installScene } = await import('/tests/helpers/history-v2-scenes.mjs');
    await installScene('stress10k100');
    return performance.now() - start;
  });
  results.graph10k100 = {
    buildMs,
    ...await measureGraph(page, cdp, 'stand-in'),
  };
});
