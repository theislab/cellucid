/**
 * The analysis engine keeps the page responsive: a marker genes run and a
 * differential expression over every gene of a 20 000-cell dataset never
 * block the main thread, the dataset's first gene read included. Chromium
 * reports long tasks (over 50 ms) directly. Firefox and WebKit have no long
 * task API and are held to the same bound by probes, each a main-thread task
 * of its own kind: a zero-delay timer re-armed from itself, the animation
 * frames, and the messages of a worker that posts every 4 ms. A task that
 * holds the main thread holds every probe, so the longest time in which no
 * probe ran at all is never less than the longest task.
 *
 * Not one probe alone. A frame also waits for the compositor, which is not
 * the main thread: Linux WebKit composites in software, and there frames
 * came 106 to 461 ms apart during these runs (233 ms with nothing but the
 * run on the page) while Chromium on the same runners reported no long task
 * for the same flows. Each probe's own longest gap is reported with a
 * failure. The dataset is read over HTTP, not through `page.route`
 * (`helpers/served-fixture.mjs` says why).
 *
 * WebKit is measured without Playwright attached
 * (`helpers/unattached-webkit.mjs`): the same WebKit build opens the app in
 * a frame of a page served beside the dataset (`unattached.html`), which
 * runs the same flow with the same probes once the scene is quiet and posts
 * the result. Playwright drives WebKit through its Web Inspector, whose
 * network agent works on the page's main thread for every chunk of every
 * response, a worker's included: WebKit carries a worker's loads through
 * its page. Measured on the Linux CI runners (ubuntu-latest, 4 cores), the
 * same page in the same build, two rounds:
 *
 * - the app's runs (that page, both flows): 84 to 115 ms with Playwright
 *   attached, 10 to 16 ms without it;
 * - 15 MB fetched by a bare worker in one request: up to 29 ms attached,
 *   19 ms without; in 15 parallel 1 MB requests: up to 86 ms attached
 *   (115 ms without a timer or a worker message), 7 ms without.
 *
 * The attached hold grows with the requests and chunks the inspector
 * observes, not with anything the app runs: no app task on the page took
 * over 3 ms (every worker message, timer and frame instrumented), starting
 * the analysis workers from their bundles instead of their sources changed
 * nothing (49 and 54 ms attached), and on macOS neither mode holds the page
 * over 13 ms. Measured attached, the bound would be Playwright's.
 *
 * The run starts once the scene is quiet (`sceneQuietness`, and the same
 * test in `unattached.html`), and draws no frame of its own. On Linux WebKit
 * a frame holds the main thread about as long as the frame gap above, so a
 * run started while the viewer still owed the frames of the dataset's
 * opening (its studio fade and settle frames) measured one of them: the
 * heartbeat held 459 ms with frames 457 ms apart, while the run itself
 * draws nothing and changes no DOM (measured in WebKit and Chromium on
 * macOS: no draw call and no mutation during either run).
 */
import { writeFileSync } from 'node:fs';

import { expect, test } from './helpers/test.mjs';
import { anndataZarrZip } from './helpers/anndata-zarr-zip.mjs';
import { writeServedFixture } from './helpers/served-fixture.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { QUIET_WINDOW_MS, sceneQuietness } from './helpers/frame-scheduling.mjs';
import { reportFromUnattachedWebKit } from './helpers/unattached-webkit.mjs';

const DATASET = 'analysis-responsive';
const CELLS = 20_000;
const GROUPS = Array.from({ length: 8 }, (_, group) => `cluster ${group}`);
const GENES = Array.from({ length: 200 }, (_, gene) => `GENE${gene}`);
/** A long task, as the Long Tasks API counts one. */
const MAIN_THREAD_BUDGET_MS = 50;
/** How long each step of opening the dataset may take (Playwright's waits use the same). */
const OPENING_TIMEOUT_MS = 120_000;

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
    'unattached.html': unattachedPage(),
    'measure.js': `window.runFlowMeasured = ${runFlowMeasured.toString()};\n`,
  });
});

test.afterAll(() => served?.remove());

/** A gap in which no probe ran, longer than this, is named in a failure's evidence. */
const REPORTED_GAP_MS = 20;

/**
 * Record what the page asked the network for, with Playwright's timings,
 * and the workers it started, each stamped with the wall clock: a failure
 * puts these beside the holds (`holdEvidence`).
 */
function recordNetwork(page) {
  const requests = [];
  const workers = [];
  const entries = new Map();
  page.on('request', request => {
    const entry = {
      url: request.url(),
      type: request.resourceType(),
      method: request.method(),
      range: request.headers().range ?? null,
      seenAt: Date.now(),
      outcome: null,
      settledAt: null,
      timing: null,
      sizes: null,
    };
    entries.set(request, entry);
    requests.push(entry);
  });
  const settle = (request, outcome) => {
    const entry = entries.get(request);
    if (entry === undefined) return;
    entry.outcome = outcome;
    entry.settledAt = Date.now();
    entry.timing = request.timing();
    entry.sizes = request.sizes().catch(() => null);
  };
  page.on('requestfinished', request => settle(request, 'finished'));
  page.on('requestfailed', request => settle(request, request.failure()?.errorText ?? 'failed'));
  page.on('worker', worker => {
    const entry = { url: worker.url(), seenAt: Date.now(), closedAt: null };
    workers.push(entry);
    worker.on('close', () => {
      entry.closedAt = Date.now();
    });
  });
  return { requests, workers };
}

/**
 * The evidence a failed run attaches: every hold longer than
 * `REPORTED_GAP_MS` and each probe's gaps over the budget, beside the
 * workers the page started (and how long each construction held it), the
 * requests in flight (Playwright's timings: sent, first byte, last byte),
 * and what the app logged, all in milliseconds from the run's start. A run
 * without Playwright attached has no requests or workers Playwright saw.
 */
async function holdEvidence(result, network = { requests: [], workers: [] }) {
  const epochStart = result.clock.timeOrigin + result.clock.startedAt;
  const fromStart = epoch => (epoch === null || epoch < 0 ? null : Math.round(epoch - epochStart));
  const windowStart = epochStart - 300;
  const windowEnd = epochStart + result.runMs + 1_000;
  const requests = [];
  for (const entry of network.requests) {
    const sent = entry.timing?.startTime ?? entry.seenAt;
    const ended = entry.settledAt ?? Infinity;
    if (ended < windowStart || sent > windowEnd) continue;
    const phase = name => {
      const value = entry.timing?.[name];
      return typeof value === 'number' && value >= 0 ? Math.round(sent + value - epochStart) : null;
    };
    const sizes = await entry.sizes;
    requests.push({
      path: new URL(entry.url).pathname,
      type: entry.type,
      method: entry.method,
      range: entry.range,
      sentMs: fromStart(sent),
      requestStartMs: phase('requestStart'),
      responseStartMs: phase('responseStart'),
      responseEndMs: phase('responseEnd'),
      // When Playwright heard of it.
      seenMs: fromStart(entry.seenAt),
      settledSeenMs: fromStart(entry.settledAt),
      outcome: entry.outcome,
      bodyBytes: sizes?.responseBodySize ?? null,
    });
  }
  const workers = network.workers
    .filter(entry => entry.seenAt >= windowStart && entry.seenAt <= windowEnd)
    .map(entry => ({ url: new URL(entry.url).pathname, seenMs: fromStart(entry.seenAt), closedMs: fromStart(entry.closedAt) }));
  return {
    summary: result.summary,
    holds: result.holds,
    probeGaps: result.probeGaps,
    longTasks: result.longTaskEntries,
    workersStarted: result.workersStarted,
    workersSeenByPlaywright: workers,
    requests,
    logged: result.logged,
    clock: result.clock,
  };
}

/**
 * The page's side of a measured run: `flowName` run in the app's window,
 * with the probes beside it. Self-contained, so it runs as its source too.
 */
async function runFlowMeasured({ flowName, budget, reportedGap }) {
  const cm = window._comparisonModule;
  const longTaskEntries = [];
  let observer = null;
  if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) longTaskEntries.push({ startTime: entry.startTime, ms: entry.duration });
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
  // The probes: when each kind of main-thread task last ran, its longest
  // gap, and every time any of them ran (and which).
  const probes = {
    timer: { last: performance.now(), gapMs: 0, gaps: [] },
    frame: { last: performance.now(), gapMs: 0, gaps: [] },
    ping: { last: performance.now(), gapMs: 0, gaps: [] },
  };
  let ran = [];
  let ranKinds = [];
  const probeRan = kind => {
    const now = performance.now();
    const probe = probes[kind];
    const gap = now - probe.last;
    probe.gapMs = Math.max(probe.gapMs, gap);
    if (gap > budget) probe.gaps.push({ at: probe.last, ms: gap });
    probe.last = now;
    ran.push(now);
    ranKinds.push(kind);
  };
  const beat = () => {
    probeRan('timer');
    if (running) setTimeout(beat, 0);
  };
  setTimeout(beat, 0);
  const frame = () => {
    probeRan('frame');
    if (running) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  const pinger = new Worker(URL.createObjectURL(new Blob(
    ['setInterval(() => postMessage(0), 4);'],
    { type: 'text/javascript' },
  )));
  pinger.onmessage = () => probeRan('ping');
  // Let the page settle, and the worker start, before the run starts.
  await new Promise(resolve => setTimeout(resolve, 200));

  // The evidence a failure reports: every worker the run starts (and how
  // long its construction held the page), and what the app logs.
  const PageWorker = window.Worker;
  const workersStarted = [];
  window.Worker = class RecordedWorker extends PageWorker {
    constructor(script, options) {
      const at = performance.now();
      super(script, options);
      workersStarted.push({
        at,
        ms: performance.now() - at,
        script: new URL(String(script), location.href).pathname,
        type: options?.type ?? 'classic',
      });
    }
  };
  const logged = [];
  const consoleNames = ['log', 'info', 'debug', 'warn', 'error'];
  const consoleMethods = Object.fromEntries(consoleNames.map(name => [name, console[name]]));
  for (const name of consoleNames) {
    console[name] = function recordedConsole(...args) {
      logged.push({ at: performance.now(), text: args.map(String).join(' ').slice(0, 400) });
      return Reflect.apply(consoleMethods[name], this, args);
    };
  }

  startedAt = performance.now();
  for (const probe of Object.values(probes)) {
    probe.last = startedAt;
    probe.gapMs = 0;
    probe.gaps = [];
  }
  ran = [startedAt];
  ranKinds = ['start'];
  draws = 0;
  longTaskEntries.length = 0;

  let genes = 0;
  try {
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
    // A hold that ends the run has no probe after it: the run's end is one.
    for (const kind of Object.keys(probes)) probeRan(kind);
  } finally {
    running = false;
    window.Worker = PageWorker;
    for (const name of consoleNames) console[name] = consoleMethods[name];
    pinger.terminate();
    observer?.disconnect();
    for (const name of drawNames) delete gl[name];
  }
  const runMs = performance.now() - startedAt;
  // Every time in which no probe ran for longer than `reportedGap`, when
  // in the run it began, and which probe ended it; the longest is the hold.
  const fromStart = at => Math.round(at - startedAt);
  let heldMs = 0;
  let heldAt = 0;
  const holds = [];
  for (let index = 1; index < ran.length; index++) {
    const gap = ran[index] - ran[index - 1];
    if (gap > heldMs) {
      heldMs = gap;
      heldAt = ran[index - 1] - startedAt;
    }
    if (gap > reportedGap) holds.push({ atMs: fromStart(ran[index - 1]), ms: Math.round(gap), endedBy: ranKinds[index] });
  }
  const summary = {
    genes,
    longTasks: longTaskEntries.map(entry => Math.round(entry.ms)),
    measuredLongTasks: observer !== null,
    heldMs: Math.round(heldMs),
    heldAtMs: Math.round(heldAt),
    runMs: Math.round(runMs),
    timerGapMs: Math.round(probes.timer.gapMs),
    frameGapMs: Math.round(probes.frame.gapMs),
    pingGapMs: Math.round(probes.ping.gapMs),
    draws,
    budget,
  };
  return {
    summary,
    runMs,
    holds,
    probeGaps: Object.fromEntries(Object.entries(probes).map(([kind, probe]) => [
      kind,
      probe.gaps.map(gap => ({ atMs: fromStart(gap.at), ms: Math.round(gap.ms) })),
    ])),
    longTaskEntries: longTaskEntries.map(entry => ({ atMs: fromStart(entry.startTime), ms: Math.round(entry.ms) })),
    workersStarted: workersStarted.map(({ at, ms, script, type }) => ({ atMs: fromStart(at), ms: Math.round(ms), script, type })),
    logged: logged.map(entry => ({ atMs: fromStart(entry.at), text: entry.text })),
    clock: {
      timeOrigin: performance.timeOrigin,
      startedAt,
      // The page's wall clock against the test's, as both read it now.
      pageMinusNodeMs: Math.round(performance.timeOrigin + performance.now() - Date.now()),
    },
  };
}

/** Run `flow` in the page while measuring how long the main thread was held. */
async function measure(page, flow) {
  const nodeBefore = Date.now();
  const result = await page.evaluate(runFlowMeasured, { flowName: flow, budget: MAIN_THREAD_BUDGET_MS, reportedGap: REPORTED_GAP_MS });
  result.clock.nodeBeforeMs = nodeBefore;
  return result;
}

/** Open the served dataset and wait until its scene is quiet. */
async function openDataset(page) {
  await page.goto(`/?sampleCatalog=${encodeURIComponent(served.root)}&dataset=${DATASET}`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await page.waitForFunction(count => window._comparisonModule?.state?.pointCount === count, CELLS, { timeout: OPENING_TIMEOUT_MS });
  // The frames the opening owes are drawn before the run, not during it.
  await expect.poll(() => sceneQuietness(page), { timeout: OPENING_TIMEOUT_MS }).toBe('quiet');
}

/**
 * The page WebKit opens without Playwright attached: the app, opened on the
 * served dataset in a frame the size of the tests' viewport, measured as
 * `openDataset` and `measure` measure it, its result posted to the address
 * in `report`. A step that fails posts why.
 */
function unattachedPage() {
  return `<!doctype html>
<meta charset="utf-8">
<title>Analysis responsiveness, unattached</title>
<style>body { margin: 0; } iframe { width: 1440px; height: 1000px; border: 0; }</style>
<body>
<script>
const query = new URLSearchParams(location.search);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, what) {
  const end = performance.now() + ${OPENING_TIMEOUT_MS};
  for (;;) {
    const value = check();
    if (value) return value;
    if (performance.now() > end) throw new Error(what + ' within ${OPENING_TIMEOUT_MS} ms');
    await sleep(50);
  }
}
/** The viewer's draw calls over the quiet window, as sceneQuietness counts them. */
async function drawsDuringQuietWindow(app) {
  const gl = app._cellucidViewer.getGLContext();
  const names = ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced'];
  let draws = 0;
  for (const name of names) {
    const original = gl[name];
    gl[name] = function countedDraw(...args) {
      draws += 1;
      return Reflect.apply(original, this, args);
    };
  }
  await sleep(${QUIET_WINDOW_MS});
  for (const name of names) delete gl[name];
  return draws;
}
async function measured() {
  const frame = document.createElement('iframe');
  frame.src = '/?sampleCatalog=' + encodeURIComponent(new URL('./', location.href).href) + '&dataset=${DATASET}';
  document.body.append(frame);
  const app = await until(() => frame.contentWindow?.document.getElementById('welcome-modal') && frame.contentWindow, 'the app did not start');
  const modal = app.document.getElementById('welcome-modal');
  const welcomeShown = () => modal.getClientRects().length > 0 && app.getComputedStyle(modal).visibility !== 'hidden';
  await until(welcomeShown, 'the welcome was not shown');
  app.document.dispatchEvent(new app.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await until(() => !welcomeShown(), 'Escape did not close the welcome');
  await until(() => app._comparisonModule?.state?.pointCount === ${CELLS}, 'the dataset did not open');
  // The frames the opening owes are drawn before the run, not during it.
  for (;;) {
    await until(() => app._cellucidViewer.getFrameScheduleState().settled, 'the scene did not settle');
    if (await drawsDuringQuietWindow(app) === 0) break;
  }
  // The app's own script: its CSP runs scripts of its origin only.
  const script = app.document.createElement('script');
  script.src = new URL('measure.js', location.href).href;
  app.document.head.append(script);
  const runFlowMeasured = await until(() => app.runFlowMeasured, 'measure.js did not load');
  return runFlowMeasured({ flowName: query.get('flow'), budget: ${MAIN_THREAD_BUDGET_MS}, reportedGap: ${REPORTED_GAP_MS} });
}
measured().then(
  result => ({ result }),
  error => ({ error: String(error?.stack || error) }),
).then(report => fetch(query.get('report'), { method: 'POST', mode: 'no-cors', body: JSON.stringify(report) }));
</script>
`;
}

/**
 * Run `flow` in WebKit without Playwright attached (`unattachedPage`).
 * Fails when the page reports no result, or a step that failed.
 */
async function measureUnattached(flow) {
  const page = new URL('unattached.html', served.root);
  page.searchParams.set('flow', flow);
  const { result, browserOutput } = await reportFromUnattachedWebKit(report => {
    page.searchParams.set('report', report);
    return page.href;
  }, { timeoutMs: OPENING_TIMEOUT_MS * 3 });
  expect(result, `WebKit reported nothing for the ${flow} run; its output:\n${browserOutput}`).not.toBeNull();
  const reported = JSON.parse(result);
  expect(reported.error, `the unattached ${flow} run failed; WebKit's output:\n${browserOutput}`).toBeUndefined();
  return reported.result;
}

for (const flow of ['markers', 'differential']) {
  test(`a ${flow} run over every gene never holds the main thread`, async ({ page, browserName }, testInfo) => {
    test.setTimeout(OPENING_TIMEOUT_MS * 4);
    let result;
    let network;
    if (browserName === 'webkit') {
      result = await measureUnattached(flow);
    } else {
      network = recordNetwork(page);
      await openDataset(page);
      result = await measure(page, flow);
    }
    const summary = result.summary;
    const held = summary.measuredLongTasks ? summary.longTasks.length > 0 : summary.heldMs > MAIN_THREAD_BUDGET_MS;
    if (held || summary.draws !== 0 || summary.genes !== GENES.length) {
      const evidence = await holdEvidence(result, network);
      const file = testInfo.outputPath(`main-thread-holds-${flow}.json`);
      writeFileSync(file, `${JSON.stringify(evidence, null, 1)}\n`);
      await testInfo.attach(`main-thread-holds-${flow}.json`, { path: file, contentType: 'application/json' });
    }
    expect(summary.genes).toBe(GENES.length);
    expect(summary.draws, `draw calls during the ${flow} run: ${JSON.stringify(summary)}`).toBe(0);
    if (summary.measuredLongTasks) {
      expect(summary.longTasks, `long tasks during the ${flow} run (ms): ${JSON.stringify(result.longTaskEntries)}`).toEqual([]);
    } else {
      expect(
        summary.heldMs,
        `longest the main thread was held during the ${flow} run (ms): ${JSON.stringify(summary)}; ` +
          `holds: ${JSON.stringify(result.holds)}`,
      ).toBeLessThanOrEqual(MAIN_THREAD_BUDGET_MS);
    }
  });
}
