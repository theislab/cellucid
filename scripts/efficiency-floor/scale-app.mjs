/**
 * The scale matrix's browser run: the whole app (Chromium) opens one store of
 * `scale-matrix.py` and exercises every feature on it, step by step, as a
 * person would — the default share, every cell, gene coloring, legends of
 * 10 and of 1,000,000 categories with a filter, differential expression,
 * markers, a gene signature, a dot plot, a kept view in 3-D, the neighbor
 * graph's edges, the velocity overlay, a session saved and restored, a figure
 * and a cell export, and Apply of 10%. Each step records its time, the bytes
 * the store server sent, the peak resident memory of the renderer and GPU
 * processes, each JavaScript thread's peak heap and ArrayBuffer bytes (CDP),
 * the main thread's long tasks, what the one memory model
 * (`data/memory-budget.js`) says it holds, the renderer's GPU bytes, and any
 * page error. With every cell open it checks values against the store's own
 * (order-free sums the generator states: `--expect`).
 *
 *   node scripts/efficiency-floor/scale-app.mjs STORE [--label L] [--steps a,b,c]
 *     [--out results.jsonl] [--pick] [--expect expect.json] [--gene G00003]
 *     [--heap-snapshots DIR] (the reader worker's heap after edges: live buffers vs reported)
 *     [--cells 10% --sample uniform|blocks] (the share the link opens with)
 *     [--link URL] (a public link instead of STORE, e.g. `cellxgene:<id>`)
 *     [--engine chromium|firefox] [--gene-next G00011] [--group-field cell_type]
 *     [--single-pass] (every analysis once on every open cell: the measured
 *     analysis costs cleared before each, so no run takes a first pass)
 *     [--trace DIR --trace-steps open,highlight] (Chromium: a performance trace
 *     of each step named, every thread with its JavaScript samples, and the
 *     page's and workers' console lines beside it)
 *
 * The store is served over loopback with ranges (a web host), or chosen as a
 * file or folder (`--pick`), or a public link is opened (`--link`). The app
 * is served on this lane's ports (`CELLUCID_BROWSER_TEST_PORT`, default
 * 4583). Run it alone (`heavy.sh`). Each step also records the requests and
 * response bytes of every data request (the store server's own count, and
 * the browser's for a link), and the grid steps (`share-grid.mjs`): the next
 * gene, frame times while the view turns, a highlight, the highlighted
 * cells' CSV and `.h5ad` export, an SVG figure and a revisit (the same link
 * opened again in the same profile, to its first gene; `revisit-de` and
 * `revisit-markers` then run the analyses on it, from the gene indexes kept
 * in the profile; `round-trip`, `round-trip-de` and `round-trip-markers`:
 * the share lowered and raised back after `de` and `markers`, and them
 * again). Firefox (`--engine
 * firefox`) has no per-thread heaps (no CDP): its process memory only.
 */

import { execSync, spawn } from 'node:child_process';
import { appendFileSync, createReadStream, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserLaunchOptions, requireHardwareRenderer } from '../lib/browser-launch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(HERE, '..', '..');
const argument = (name, fallback = null) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const remoteLink = argument('--link', null);
const store = remoteLink === null ? path.resolve(process.argv[2]) : null;
const label = argument('--label', store === null ? remoteLink : path.basename(store));
const engine = argument('--engine', 'chromium');
const shareCells = argument('--cells', null);
const shareSample = argument('--sample', null);
const geneNext = argument('--gene-next', 'G00011');
const groupField = argument('--group-field', 'cell_type');
const out = argument('--out', null);
const pick = process.argv.includes('--pick');
const gene = argument('--gene', 'G00010');
// Every analysis runs once, on every open cell, as on a first opening: the
// measured analysis costs (`progressive-cells.js` `AnalysisCostModel`) are
// cleared before each, so a run is never split into a first pass on a sample
// and the pass on every cell (which a later run of a measured kind is).
const singlePass = process.argv.includes('--single-pass');
const ALL_STEPS = ['open', 'grow', 'gene', 'legend', 'legend-1m', 'filter', 'share-round-trip', 'de', 'markers', 'signature', 'dotplot',
  'multiview', 'edges', 'knn', 'velocity', 'session', 'figure', 'cells', 'apply-10'];
const steps = (argument('--steps', ALL_STEPS.join(','))).split(',');
const traceDir = argument('--trace', null);
const traceSteps = new Set((argument('--trace-steps', 'open')).split(','));
const expected = argument('--expect', null) === null ? null : JSON.parse((await import('node:fs')).readFileSync(argument('--expect'), 'utf8'));
const appPort = Number(process.env.CELLUCID_BROWSER_TEST_PORT ?? 4583);
process.env.CELLUCID_BROWSER_TEST_PORT = String(appPort);
process.env.CELLUCID_BROWSER_TEST_SAMPLE_PORT = String(appPort + 1);
const storePort = appPort + 3;
const cdpPort = appPort + 4;
const downloads = mkdtempSync(path.join(tmpdir(), 'scale-app-'));
const MB = bytes => Math.round(bytes / 1048576);

// ---- the store, with ranges and CORS, as a web host serves it --------------
let servedBytes = 0;
let servedRequests = 0;
// Every served range, one JSON line each, with a line at each step's start
// (`SCALE_APP_REQUEST_LOG=file`): which bytes a step read, for a trace.
const requestLog = process.env.SCALE_APP_REQUEST_LOG ?? null;
// A link's data requests as the browser counts them (every page and worker
// of the context): requests, and response body bytes once each finished.
let linkRequests = 0;
let linkBytes = 0;
const storeServer = createServer((request, response) => {
  const file = path.join(path.dirname(store), decodeURIComponent(new URL(request.url, 'http://x').pathname));
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length, ETag, Accept-Ranges', 'Accept-Ranges': 'bytes' };
  if (request.method === 'OPTIONS') { response.writeHead(204, headers).end(); return; }
  let size;
  try { size = statSync(file).size; } catch { response.writeHead(404, headers).end(); return; }
  headers.ETag = `"${size}-${Math.round(statSync(file).mtimeMs)}"`;
  // A range `bytes=a-b` or `bytes=a-`, or a suffix `bytes=-n` (a Zarr
  // shard's index at its end), as every web host answers them: a suffix
  // answered with the whole file read a 10M-cell store's shards whole.
  const plain = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
  const suffix = /^bytes=-(\d+)$/.exec(request.headers.range ?? '');
  const range = plain ?? suffix;
  const start = plain ? Number(plain[1]) : suffix ? Math.max(0, size - Number(suffix[1])) : 0;
  const end = plain && plain[2] !== '' ? Math.min(size - 1, Number(plain[2])) : size - 1;
  response.writeHead(range ? 206 : 200, { ...headers, 'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
  servedRequests++;
  if (request.method === 'HEAD') { response.end(); return; }
  servedBytes += end - start + 1;
  if (requestLog !== null) appendFileSync(requestLog, `${JSON.stringify({ file: path.relative(path.dirname(store), file), start, end: end + 1, t: Math.round(performance.now()) })}\n`);
  createReadStream(file, { start, end }).pipe(response);
});
await new Promise(resolve => storeServer.listen(storePort, '127.0.0.1', resolve));
const app = spawn(process.execPath, [path.join(REPOSITORY, 'scripts', 'serve-browser-tests.mjs')], { cwd: REPOSITORY, env: process.env, stdio: 'ignore' });
// The app server goes with this run however it ends (a deadline's SIGTERM included).
process.on('exit', () => app.kill());
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { try { process.kill(rootPid, 'SIGKILL'); } catch { /* gone */ } process.exit(1); });
const APP = `http://127.0.0.1:${appPort}`;
for (let i = 0; i < 150; i++) {
  try { if ((await fetch(`${APP}/`)).ok) break; } catch { /* not yet */ }
  await new Promise(resolve => setTimeout(resolve, 200));
}

const playwright = await import(`${REPOSITORY}/node_modules/playwright/index.mjs`);
const cdp = engine === 'chromium';
// The machine's GPU (`lib/browser-launch.mjs`): a software renderer
// (SwiftShader) draws every frame on the CPU, so each frame of millions of
// points or edges is seconds of main-thread wait.
// Launched here, not through a browser server: a browser Playwright reaches
// over a connection is taken for a remote one, and a picked store (`--pick`)
// is then streamed into it through the protocol (about 30 s for 700 MB)
// instead of handed over by its path, as a person's pick is.
const browser = await playwright[engine].launch(browserLaunchOptions(engine, cdp ? { args: [`--remote-debugging-port=${cdpPort}`] } : {}));
// Firefox under Playwright is the newest process started with its pipe.
const rootPid = Number(execSync(cdp ? `pgrep -f -- "--remote-debugging-port=${cdpPort}" | head -1` : 'pgrep -n -f -- "-juggler-pipe"').toString().trim());

// ---- per-thread heaps over raw CDP (every page and worker, nested) --------
let wsUrl = null;
for (let i = 0; cdp && i < 50 && wsUrl === null; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()).webSocketDebuggerUrl; } catch { await new Promise(resolve => setTimeout(resolve, 200)); }
}
// Firefox: no CDP; a stand-in that answers nothing (heaps are then empty).
const ws = cdp ? new WebSocket(wsUrl) : { send() {}, close() {} };
if (cdp) await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 1;
const waiting = new Map();
const sessions = new Map();
function send(method, params = {}, sessionId = undefined, timeoutMs = 5000) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    setTimeout(() => { if (waiting.delete(id)) reject(new Error(`timeout ${method}`)); }, timeoutMs);
  });
}
/** Heap snapshot chunks arriving, by session (`HeapProfiler.addHeapSnapshotChunk`). */
const snapshotChunks = new Map();
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined) {
    const entry = waiting.get(message.id);
    waiting.delete(message.id);
    if (entry) (message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result));
    return;
  }
  if (message.method === 'HeapProfiler.addHeapSnapshotChunk') {
    snapshotChunks.get(message.sessionId)?.push(message.params.chunk);
    return;
  }
  if (message.method === 'Target.attachedToTarget') {
    const { sessionId, targetInfo } = message.params;
    sessions.set(sessionId, { type: targetInfo.type, url: targetInfo.url });
    if (targetInfo.type === 'page' || targetInfo.type === 'worker') send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).catch(() => {});
  } else if (message.method === 'Target.detachedFromTarget') {
    sessions.delete(message.params.sessionId);
  }
};
if (cdp) await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
const threadKind = (type, url) => {
  if (type === 'page') return 'page';
  const base = (url ?? '').split('?')[0].split('/').pop();
  return base.replace(/\.js$/, '').replace(/-[0-9a-f]{6,}$/, '') || 'worker';
};
async function heaps() {
  const rows = [];
  if (!cdp) return rows;
  await Promise.all([...sessions.entries()].map(async ([sid, info]) => {
    if (info.type !== 'page' && info.type !== 'worker') return;
    try {
      const heap = await send('Runtime.getHeapUsage', {}, sid);
      rows.push({ kind: threadKind(info.type, info.url), bytes: heap.usedSize + (heap.backingStorageSize ?? 0) });
    } catch { /* gone */ }
  }));
  return rows;
}
/**
 * Each thread's heap and ArrayBuffers now, and again after a forced garbage
 * collection in every thread (`HeapProfiler.collectGarbage`): what a step
 * left reachable, against what was only not yet collected.
 */
async function heldAfterCollection() {
  const sum = rows => {
    const byKind = {};
    for (const row of rows) byKind[row.kind] = (byKind[row.kind] ?? 0) + row.bytes;
    return Object.fromEntries(Object.entries(byKind).map(([kind, bytes]) => [kind, MB(bytes)]));
  };
  const before = sum(await heaps());
  await Promise.all([...sessions.entries()].map(([sid, info]) => (info.type === 'page' || info.type === 'worker')
    ? send('HeapProfiler.collectGarbage', {}, sid).catch(() => {}) : null));
  await new Promise(resolve => setTimeout(resolve, 1000));
  return { beforeMB: before, afterCollectionMB: sum(await heaps()) };
}
/**
 * A heap snapshot of every thread of one kind (`--heap-snapshots DIR`), after
 * a collection, summed: the bytes of the ArrayBuffers alive in it (each
 * buffer's `system / JSArrayBufferData`), against what the thread reports
 * (`usedSize + backingStorageSize`). What is reported beyond the live
 * buffers and objects is memory not held by anything reachable.
 */
async function heapSnapshots(kind, label) {
  const dir = argument('--heap-snapshots', null);
  if (dir === null) return null;
  const out = [];
  for (const [sid, info] of sessions) {
    if (threadKind(info.type, info.url) !== kind) continue;
    await send('HeapProfiler.collectGarbage', {}, sid).catch(() => {});
    const usage = await send('Runtime.getHeapUsage', {}, sid).catch(() => null);
    snapshotChunks.set(sid, []);
    await send('HeapProfiler.enable', {}, sid).catch(() => {});
    await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false }, sid, 600_000);
    const text = snapshotChunks.get(sid).join('');
    snapshotChunks.delete(sid);
    const file = path.join(dir, `${label}-${kind}-${out.length}.heapsnapshot`);
    (await import('node:fs')).writeFileSync(file, text);
    const snap = JSON.parse(text);
    const fields = snap.snapshot.meta.node_fields;
    const width = fields.length;
    const nameAt = fields.indexOf('name');
    const sizeAt = fields.indexOf('self_size');
    let buffers = 0;
    let largest = [];
    let objects = 0;
    for (let i = 0; i < snap.nodes.length; i += width) {
      const size = snap.nodes[i + sizeAt];
      if (snap.strings[snap.nodes[i + nameAt]] === 'system / JSArrayBufferData') {
        buffers += size;
        if (size >= 16 * 1024 * 1024) largest.push(size);
      } else objects += size;
    }
    largest = largest.sort((a, b) => b - a).slice(0, 12).map(MB);
    out.push({ file, reportedMB: usage === null ? null : MB(usage.usedSize + (usage.backingStorageSize ?? 0)), liveBuffersMB: MB(buffers), objectsMB: MB(objects), largestBuffersMB: largest });
  }
  return out;
}
function processes() {
  const rows = execSync('ps -A -o pid=,ppid=,rss=,command=').toString().trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return { pid: +match[1], ppid: +match[2], rss: +match[3] * 1024, command: match[4] };
  });
  const tree = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (!tree.has(row.pid) && tree.has(row.ppid)) { tree.add(row.pid); grew = true; }
  }
  const result = { renderer: 0, gpu: 0, all: 0 };
  for (const row of rows) {
    if (!tree.has(row.pid)) continue;
    result.all += row.rss;
    if (row.command.includes('--type=renderer') || / tab$/.test(row.command)) result.renderer = Math.max(result.renderer, row.rss);
    else if (row.command.includes('--type=gpu-process') || (row.command.includes('-contentproc') && / gpu$/.test(row.command))) result.gpu += row.rss;
  }
  return result;
}
let peaks = null;
let sampling = false;
const sampler = setInterval(async () => {
  if (sampling || peaks === null) return;
  sampling = true;
  try {
    const proc = processes();
    peaks.renderer = Math.max(peaks.renderer, proc.renderer);
    peaks.gpu = Math.max(peaks.gpu, proc.gpu);
    peaks.all = Math.max(peaks.all, proc.all);
    const byKind = {};
    for (const row of await heaps()) byKind[row.kind] = (byKind[row.kind] ?? 0) + row.bytes;
    let total = 0;
    for (const [kind, bytes] of Object.entries(byKind)) { peaks.threads[kind] = Math.max(peaks.threads[kind] ?? 0, bytes); total += bytes; }
    peaks.js = Math.max(peaks.js, total);
  } catch { /* a crashed page */ } finally { sampling = false; }
}, 400);

// ---- the page --------------------------------------------------------------
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const errors = [];
// Every data request of the context (pages and workers): the app's own
// files are not data.
const isData = url => !url.startsWith(`http://127.0.0.1:${appPort}/`) && !url.startsWith('data:') && !url.startsWith('blob:');
context.on('request', request => { if (isData(request.url())) linkRequests++; });
context.on('requestfinished', request => {
  if (!isData(request.url())) return;
  request.sizes().then(sizes => { linkBytes += sizes.responseBodySize; }, () => {});
});
function watchPage(target) {
  if (traceDir !== null) {
    mkdirSync(traceDir, { recursive: true });
    target.on('console', message => appendFileSync(path.join(traceDir, `${label}-console.log`), `${Math.round(performance.now())} ${message.type()} ${message.text().slice(0, 2000)}\n`));
  }
  target.on('pageerror', error => errors.push(`page: ${String(error.stack ?? error).slice(0, 400)}`));
  target.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text().slice(0, 400)}`); });
  target.on('crash', () => errors.push('page crashed'));
}
let page = await context.newPage();
watchPage(page);
await context.addInitScript(() => {
  window.__longTasks = [];
  try {
    new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__longTasks.push([entry.startTime, entry.duration]); })
      .observe({ type: 'longtask', buffered: true });
  } catch { /* no long-task timing */ }
});

const state = () => page.evaluate(() => {
  const s = window._cellucidState;
  return { cells: s?.pointCount ?? 0, phase: document.documentElement.dataset.startupPhase, notice: document.getElementById('subsample-notice')?.dataset.state ?? null };
});
async function settled(timeout = 1_800_000) {
  const ready = () => page.waitForFunction(() => {
    const s = window._cellucidState;
    return (s?.pointCount ?? 0) > 0 && document.documentElement.dataset.startupPhase === 'ready'
      && document.getElementById('subsample-notice')?.dataset.state !== 'growing';
  }, null, { timeout, polling: 250 });
  // A progressive opening's growth starts once the first view is published:
  // between the two the page looks settled. Settled is the cells' count
  // staying put a second and a half without a growth starting; the time is
  // when it last was reached (the caller's clock reads it then).
  for (;;) {
    await ready();
    const reachedAt = performance.now();
    const cells = (await state()).cells;
    await page.waitForTimeout(1500);
    const now = await state();
    if (now.cells === cells && now.notice !== 'growing') return reachedAt;
  }
}
async function quiet(ms = 1500) {
  // Until no long task for `ms` (the work a step started has finished).
  for (let i = 0; i < 600; i++) {
    const last = await page.evaluate(() => { const t = window.__longTasks.at(-1); return t ? t[0] + t[1] : 0; });
    const now = await page.evaluate(() => performance.now());
    if (now - last >= ms) return;
    await page.waitForTimeout(250);
  }
}
async function memoryModel() {
  return page.evaluate(async () => {
    const budget = await import('./assets/js/data/memory-budget.js');
    const report = budget.memoryReport();
    return { allowanceMB: Math.round(report.allowanceBytes / 1048576), heldMB: Math.round(report.heldBytes / 1048576),
      shares: Object.fromEntries(Object.entries(report.shares).filter(([, v]) => v.heldBytes > 0).map(([k, v]) => [k, Math.round(v.heldBytes / 1048576)])) };
  }).catch(error => ({ error: String(error).slice(0, 120) }));
}
async function gpuMB() {
  return page.evaluate(() => {
    const viewer = window._cellucidViewer;
    try { return Math.round(viewer.getRendererStats(viewer.getActiveViewId?.() ?? 'live')?.gpuMemoryMB ?? -1); } catch { return null; }
  }).catch(() => null);
}

/**
 * Wait for the dataset to show (`pointCount` past `before`), or fail as soon
 * as the app says the opening failed: a refused or failed opening otherwise
 * held the run until the step's timeout (20 minutes of a 50M run spent on a
 * link the app had refused at once).
 */
async function opened(before, since, { name = false } = {}) {
  let failed = null;
  const watch = new Promise((_, reject) => {
    failed = setInterval(() => {
      const refusal = errors.slice(since).find(text => /did not open|could not be opened|cannot open|page crashed/i.test(text));
      if (refusal !== undefined) reject(new Error(`opening failed: ${refusal.slice(0, 240)}`));
    }, 250);
  });
  try {
    await Promise.race([
      // A picked store is shown once the dataset's name changes to it: the
      // start page's own sample (its cells) may arrive meanwhile.
      page.waitForFunction(([n, prior, byName]) => {
        const count = window._cellucidState?.pointCount ?? 0;
        if (!byName) return count !== n && count > 0;
        const shown = document.getElementById('dataset-name')?.textContent.trim() ?? '';
        return count > 0 && shown !== '' && shown !== prior && !/opening/i.test(shown);
      }, [before.cells ?? before, before.name ?? null, name], { timeout: 1_800_000, polling: 100 }),
      watch,
    ]);
  } finally {
    clearInterval(failed);
  }
}

const results = [];
async function step(name, operation, { timeout = 600_000 } = {}) {
  if (!steps.includes(name)) return;
  if (requestLog !== null) appendFileSync(requestLog, `${JSON.stringify({ step: name, store: label, share: shareCells === null ? '100%' : `${shareCells} ${shareSample ?? ''}`, t: Math.round(performance.now()) })}\n`);
  peaks = { renderer: 0, gpu: 0, all: 0, js: 0, threads: {} };
  const bytesBefore = servedBytes;
  const requestsBefore = servedRequests;
  const linkBefore = [linkRequests, linkBytes];
  const errorsBefore = errors.length;
  const startedAt = await page.evaluate(() => performance.now()).catch(() => 0);
  const started = performance.now();
  let detail = null;
  let failure = null;
  // The step's deadline is cleared when it ends: a pending 30-minute timer
  // kept the run alive that long after its last step.
  let deadline = null;
  const tracing = traceDir !== null && engine === 'chromium' && traceSteps.has(name);
  if (tracing) {
    const share = shareCells === null ? '100' : `${shareCells.replace('%', '')}${shareSample ?? ''}`;
    await browser.startTracing(page, {
      path: path.join(traceDir, `${label}-${share}-${name}.trace.json`),
      categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute', 'disabled-by-default-v8.cpu_profiler', 'blink.user_timing', 'gpu', 'toplevel'],
    });
  }
  try {
    detail = await Promise.race([operation(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(`timeout ${timeout} ms`)), timeout); })]);
  } catch (error) {
    failure = String(error.message ?? error).split('\n')[0].slice(0, 900);
  } finally {
    clearTimeout(deadline);
    if (tracing) await browser.stopTracing().catch(() => {});
  }
  const ms = Math.round(performance.now() - started);
  await new Promise(resolve => setTimeout(resolve, 500));
  const tasks = await page.evaluate(since => window.__longTasks.filter(([at]) => at >= since).map(([, d]) => d), startedAt).catch(() => []);
  const row = {
    store: label, step: name, ms, failure, detail,
    servedMB: Math.round((servedBytes - bytesBefore) / 1e5) / 10,
    servedRequests: servedRequests - requestsBefore,
    linkRequests: linkRequests - linkBefore[0], linkMB: Math.round((linkBytes - linkBefore[1]) / 1e5) / 10,
    share: shareCells === null ? null : `${shareCells}${shareSample === null ? '' : ` ${shareSample}`}`, engine,
    rendererMB: MB(peaks.renderer), gpuProcessMB: MB(peaks.gpu), browserMB: MB(peaks.all), jsMB: MB(peaks.js),
    threadsMB: Object.fromEntries(Object.entries(peaks.threads).map(([k, v]) => [k, MB(v)])),
    longTasks: { count: tasks.length, totalMs: Math.round(tasks.reduce((a, b) => a + b, 0)), maxMs: Math.round(Math.max(0, ...tasks)) },
    model: await memoryModel(), rendererGpuMB: await gpuMB(), cells: (await state().catch(() => ({}))).cells ?? null,
    errors: errors.slice(errorsBefore, errorsBefore + 5),
  };
  peaks = null;
  results.push(row);
  console.log(JSON.stringify(row));
  if (out !== null) appendFileSync(out, `${JSON.stringify(row)}\n`);
}

/** Analysis kinds whose measured costs the last `--single-pass` run cleared. */
let costsCleared = null;

async function analysis(id, options, buttonName, extra = {}) {
  await page.evaluate(() => { document.getElementById('page-analysis-section').open = true; });
  const before = await page.evaluate(key => window._comparisonModule.getUI(key)?._lastResult ?? null, id).then(() => null);
  await page.evaluate(([key, opts, more]) => { window.__before = window._comparisonModule.getUI(key)?._lastResult ?? null; return window._comparisonModule.openAnalysis(key, { ...more, options: opts }); }, [id, options, extra]);
  const panel = page.locator(`#analysis-panel-${id}`);
  await panel.waitFor({ state: 'visible' });
  const button = panel.getByRole('button', { name: buttonName });
  await button.waitFor({ state: 'visible' });
  await page.waitForFunction(element => !element.disabled, await button.elementHandle(), { timeout: 600_000 });
  const errorsBefore = errors.length;
  if (singlePass) {
    // The page's own module instance: its path, which the page's import map
    // resolves to the URL the app imported (a resource entry is no way to
    // find it: the page's resource timing buffer holds its first 250
    // entries, and a 10M-cell page fills it before this module loads, so the
    // costs were never cleared and runs after the first took a first pass).
    // The kinds cleared are recorded with the run (`costsCleared`): after a
    // first run, the kinds it measured (the app's instance, not another).
    costsCleared = await page.evaluate(async () => {
      localStorage.removeItem('cellucid:analysis-cost:v2');
      const model = (await import('./assets/js/app/analysis/shared/progressive-cells.js')).getAnalysisCostModel();
      const kinds = model._passes.size;
      model._passes.clear();
      return kinds;
    });
  }
  await button.click();
  // A run that fails says so on the console: the step fails then, not at its deadline.
  let watch = null;
  const failed = new Promise((_, reject) => {
    watch = setInterval(() => {
      const hit = errors.slice(errorsBefore).find(error => /failed/i.test(error));
      if (hit !== undefined) reject(new Error(hit.split('\n')[0].slice(0, 300)));
    }, 500);
  });
  try {
    await Promise.race([failed, page.waitForFunction(key => {
      const result = window._comparisonModule.getUI(key)?._lastResult;
      return result !== null && result !== undefined && result !== window.__before;
    }, id, { timeout: 1_800_000, polling: 250 })]);
  } catch (error) {
    // What the run was doing when it gave up: its job's step and items, the
    // open cells and the gene sample (a run waiting on either says so).
    const where = await page.evaluate(key => {
      const ui = window._comparisonModule.getUI(key);
      const job = ui?._shownJob ?? null;
      const s = window._cellucidState;
      return {
        job: job === null ? null : { state: job.state, step: job.stepText ?? null, items: [job.itemsDone ?? null, job.itemsTotal ?? null] },
        loading: ui?.isLoading?.() ?? null,
        cells: s?.pointCount ?? null,
        notice: document.getElementById('subsample-notice')?.dataset.state ?? null,
        geneSample: s?.getGeneSample?.() ?? null,
        growth: s?.getGeneSampleGrowth?.() ?? null,
      };
    }, id).catch(() => null);
    throw new Error(`${String(error.message ?? error).split('\n')[0]} | ${JSON.stringify(where)}`);
  } finally {
    clearInterval(watch);
  }
  void before;
}

/** Open every collapsed section holding `selector`, then bring it into view. */
async function reveal(selector) {
  await page.locator(selector).first().waitFor({ state: 'attached', timeout: 600_000 });
  await page.evaluate(css => {
    for (let node = document.querySelector(css); node !== null; node = node.parentElement) {
      if (node.tagName === 'DETAILS') node.open = true;
      if (node.hidden) node.hidden = false;
    }
  }, selector);
  await page.locator(selector).first().scrollIntoViewIfNeeded().catch(() => {});
  return page.locator(selector).first();
}
/** A control's value set as a person sets it (its input and change events). */
async function setControl(selector, value) {
  await reveal(selector);
  await page.evaluate(([css, next]) => {
    const element = document.querySelector(css);
    if (element.type === 'checkbox') {
      if (element.checked !== next) element.click();
      return;
    }
    if (element.tagName === 'SELECT') {
      const option = [...element.options].find(o => o.textContent.trim() === next || o.value === next);
      if (!option) throw new Error(`${css} has no option ${next}`);
      element.value = option.value;
    } else {
      element.value = String(next);
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, [selector, value]);
}

async function fieldIndex(kind, key) {
  return page.evaluate(([k, name]) => {
    const s = window._cellucidState;
    const fields = k === 'var' ? s.varData.fields : s.obsData.fields;
    return fields.findIndex(field => field.key === name);
  }, [kind, key]);
}

/** The page address that opens the store (or `--link`) at the share asked. */
function pageAddress() {
  const link = remoteLink ?? `http://127.0.0.1:${storePort}/${encodeURIComponent(path.basename(store))}`;
  const share = shareCells === null ? '' : `&cells=${encodeURIComponent(shareCells)}${shareSample === null ? '' : `&sample=${shareSample}`}`;
  return `${APP}/?data=${encodeURIComponent(link)}${share}`;
}
/** A gene colored, timed from the ask to its values in the page. */
async function colorGene(name) {
  await page.waitForFunction(() => !window._cellucidState.areGenesPending?.() && window._cellucidState.varData.fields.length > 0, null, { timeout: 600_000 });
  const index = await fieldIndex('var', name);
  if (index < 0) throw new Error(`gene ${name} not listed`);
  return page.evaluate(async i => {
    const s = window._cellucidState;
    const t0 = performance.now();
    await s.ensureVarFieldLoaded(i);
    s.setActiveVarField(i);
    return { loadMs: Math.round(performance.now() - t0), geneSampleCells: s.getGeneSample?.()?.cells ?? null };
  }, index);
}
/** The highlighted cells exported (`csv` or `h5ad`), timed to the saved file. */
async function exportHighlight(kind) {
  const download = page.waitForEvent('download', { timeout: 1_800_000 });
  const t0 = performance.now();
  await (await reveal(`#export-highlights-${kind}`)).click();
  const file = await download;
  const target = path.join(downloads, file.suggestedFilename());
  await file.saveAs(target);
  return { ms: Math.round(performance.now() - t0), file: file.suggestedFilename(), bytes: statSync(target).size };
}
/** A figure of the view in `format`, edges and velocity off (a figure draws points only). */
async function figure(format) {
  await setControl('#toggle-connectivity', false).catch(() => {});
  await setControl('#velocity-overlay-enabled', false).catch(() => {});
  await quiet(1000);
  await reveal('#figure-export-btn');
  const downloadSection = page.getByRole('button', { name: /^Download\b/ });
  if (await downloadSection.count() > 0) await downloadSection.first().click().catch(() => {});
  await page.getByLabel('Download format').selectOption(format);
  // An SVG asks how its points are drawn: raster points under vector text
  // (`hybrid`, the choice for millions of cells); nothing is exported until one is chosen.
  if (format === 'svg') await page.getByLabel('SVG point strategy').selectOption('hybrid');
  const download = page.waitForEvent('download', { timeout: 1_800_000 });
  const blocked = page.locator('.figure-export-modal[aria-label="Export blocked"]').waitFor({ state: 'visible', timeout: 1_800_000 })
    .then(async () => { throw new Error(`figure export blocked: ${(await page.locator('.figure-export-modal').innerText()).replace(/\s+/g, ' ').slice(0, 400)}`); });
  blocked.catch(() => {});
  const t0 = performance.now();
  await (await reveal('#figure-export-btn')).click();
  const file = await Promise.race([download, blocked]);
  const target = path.join(downloads, file.suggestedFilename());
  await file.saveAs(target);
  return { ms: Math.round(performance.now() - t0), file: file.suggestedFilename(), bytes: statSync(target).size };
}

try {
  // ---- open at the default share (or the share asked) ------------------
  await step('open', async () => {
    if (pick) {
      await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
      await page.locator('#welcome-modal').waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.documentElement.dataset.startupPhase === 'ready', null, { timeout: 120_000 });
      const folder = statSync(store).isDirectory() && !store.endsWith('.zarr.zip');
      const input = page.locator(folder ? '#user-data-folder-input' : '#user-data-file-input');
      await page.waitForFunction(id => !document.getElementById(id).disabled, folder ? 'user-data-folder-input' : 'user-data-file-input');
      // The start page's sample settles first (an opening it superseded
      // would be the pick's failure, not the store's), then the pick is
      // known by the dataset's name.
      for (let calm = 0; calm < 2;) {
        const busy = await page.evaluate(() => document.documentElement.dataset.startupPhase !== 'ready'
          || document.getElementById('subsample-notice')?.dataset.state === 'growing'
          || /opening|loading/i.test(document.getElementById('dataset-name')?.textContent ?? ''));
        calm = busy ? 0 : calm + 1;
        await page.waitForTimeout(1000);
      }
      const before = await page.evaluate(() => ({ cells: window._cellucidState?.pointCount ?? 0, name: document.getElementById('dataset-name')?.textContent.trim() ?? '' }));
      const t0 = performance.now();
      const since = errors.length;
      await input.setInputFiles(store);
      await opened(before, since, { name: true });
      const firstFrameMs = Math.round(performance.now() - t0);
      await settled();
      const renderer = await requireHardwareRenderer(page);
      return { firstFrameMs, ...(await state()), share: await page.locator('#subsample-percent').inputValue().catch(() => null), renderer };
    }
    const t0 = performance.now();
    const since = errors.length;
    await page.goto(pageAddress(), { waitUntil: 'domcontentloaded' });
    await opened(0, since);
    const firstFrameMs = Math.round(performance.now() - t0);
    const firstCells = (await state()).cells;
    const settledMs = Math.round((await settled()) - t0);
    const renderer = await requireHardwareRenderer(page);
    return { firstFrameMs, firstCells, settledMs, ...(await state()), share: await page.locator('#subsample-percent').inputValue().catch(() => null), renderer };
  }, { timeout: 1_200_000 });
  await page.evaluate(() => { for (const id of ['page-analysis-section', 'figure-export-section']) { const el = document.getElementById(id); if (el) el.open = true; } });

  // ---- every cell -----------------------------------------------------
  await step('grow', async () => {
    await setControl('#subsample-percent', '100');
    const apply = await reveal('#subsample-apply');
    if (await apply.isEnabled()) await apply.click();
    await page.waitForFunction(() => document.getElementById('subsample-notice')?.dataset.state !== 'growing', null, { timeout: 1_800_000, polling: 250 });
    await settled();
    await quiet();
    return state();
  }, { timeout: 1_200_000 });

  // ---- a gene, its values checked ------------------------------------
  await step('gene', async () => {
    await page.waitForFunction(() => !window._cellucidState.areGenesPending?.() && window._cellucidState.varData.fields.length > 0, null, { timeout: 600_000 });
    const index = await fieldIndex('var', gene);
    if (index < 0) throw new Error(`gene ${gene} not listed`);
    const check = await page.evaluate(async i => {
      const s = window._cellucidState;
      await s.ensureVarFieldLoaded(i);
      s.setActiveVarField(i);
      const values = s.varData.fields[i].values;
      let sum = 0; let nonzero = 0; let missing = 0;
      const samples = [];
      for (let c = 0; c < values.length; c++) {
        const v = values[c];
        if (!Number.isFinite(v)) { missing++; continue; }
        if (v !== 0) { sum += v; nonzero++; if (samples.length < 20 && c % 97 === 0) samples.push([s.cellIdentity.originalAt(c), v]); }
      }
      const sample = s.getGeneSample?.() ?? null;
      return { length: values.length, sum, nonzero, missing, geneSampleCells: sample?.cells ?? null, samples };
    }, index);
    await quiet();
    if (expected?.gene && check.length === expected.cells && check.missing === 0) check.matches = check.sum === expected.gene.sum && check.nonzero === expected.gene.nonzero;
    return check;
  });

  // ---- the share grid's steps (`share-grid.mjs`) -----------------------
  await step('gene-next', async () => { const result = await colorGene(geneNext); await quiet(); return result; });
  await step('frames', async () => {
    // The view turned for 3 s (a drag across the canvas): each frame's
    // interval, with what the renderer drew (points, LOD level, draw calls).
    const box = await page.locator('#glcanvas').boundingBox();
    await page.evaluate(() => {
      window.__frames = [];
      let last = performance.now();
      const tick = now => { window.__frames.push(now - last); last = now; if (window.__frames.length < 100000 && !window.__framesStop) requestAnimationFrame(tick); };
      window.__framesStop = false;
      requestAnimationFrame(tick);
    });
    const cx = box.x + box.width / 2; const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    const t0 = performance.now();
    for (let i = 0; performance.now() - t0 < 3000; i++) await page.mouse.move(cx + 200 * Math.sin(i / 10), cy + 60 * Math.cos(i / 10), { steps: 1 });
    await page.mouse.up();
    const frames = await page.evaluate(() => { window.__framesStop = true; return window.__frames.slice(1); });
    const sorted = [...frames].sort((a, b) => a - b);
    const at = q => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] * 10) / 10;
    const stats = await page.evaluate(() => {
      const viewer = window._cellucidViewer;
      try { const s = viewer.getRendererStats(viewer.getActiveViewId?.() ?? 'live'); return { visiblePoints: s.visiblePoints, lodLevel: s.lodLevel, drawCalls: s.drawCalls }; } catch (error) { return { error: String(error).slice(0, 120) }; }
    });
    await quiet();
    return { frames: frames.length, medianMs: at(0.5), p95Ms: at(0.95), ...stats };
  });
  await step('highlight', async () => {
    // One category of the group field highlighted (its cells scale with the share).
    await setControl('#categorical-field', groupField);
    await page.locator('.legend-item').first().waitFor({ state: 'visible', timeout: 600_000 });
    const t0 = performance.now();
    const cells = await page.evaluate(field => {
      const s = window._cellucidState;
      const i = s.obsData.fields.findIndex(f => f.key === field);
      s.ensureHighlightPage();
      s.addHighlightFromCategory(i, 0, 'obs');
      return s.getHighlightedCellCount?.() ?? null;
    }, groupField);
    const ms = Math.round(performance.now() - t0);
    await quiet();
    return { ms, cells };
  });
  await step('export-csv', () => exportHighlight('csv'), { timeout: 1_800_000 });
  await step('export-h5ad', () => exportHighlight('h5ad'), { timeout: 300_000 });
  await step('figure-svg', () => figure('svg'), { timeout: 300_000 });

  // ---- legends: 10 categories, then 1,000,000; a filter --------------
  await step('legend', async () => {
    await setControl('#categorical-field', 'cell_type');
    await page.locator('.legend-item').first().waitFor({ state: 'visible', timeout: 600_000 });
    await quiet();
    const counts = await page.evaluate(async () => {
      const s = window._cellucidState;
      const field = s.getActiveField();
      const tally = new Array(field.categories.length).fill(0);
      for (const code of field.codes) tally[code]++;
      return { categories: field.categories.length, tally };
    });
    if (expected?.cellTypes && counts.tally.reduce((a, b) => a + b, 0) === expected.cells) counts.matches = JSON.stringify(counts.tally) === JSON.stringify(expected.cellTypes);
    return counts;
  });
  await step('legend-1m', async () => {
    await setControl('#categorical-field', 'barcode_group');
    await page.waitForFunction(() => document.querySelector('.legend-item .legend-label-main')?.textContent?.startsWith('bg '), null, { timeout: 600_000 });
    await quiet();
    return { rows: await page.locator('.legend-item').count(), categories: await page.evaluate(() => window._cellucidState.getActiveField().categories.length) };
  });
  await step('filter', async () => {
    // The first drawn row whose category has open cells: a share opens a
    // dictionary larger than its cells in stored order, so a row may count no
    // cell, and hiding it filters nothing ("Showing all …", never "Showing N of").
    const catIndex = await page.evaluate(() => {
      const field = window._cellucidState.getActiveField();
      const has = new Uint8Array(field.categories.length);
      for (const code of field.codes) has[code] = 1;
      const row = [...document.querySelectorAll('.legend-item')].find(item => has[Number(item.dataset.catIndex)] === 1);
      return row ? row.dataset.catIndex : null;
    });
    if (catIndex === null) throw new Error('no drawn legend row counts an open cell');
    const row = page.locator(`.legend-item[data-cat-index="${catIndex}"]`);
    await row.locator('.legend-checkbox').evaluate(box => { if (box.checked) box.click(); });
    await page.waitForFunction(() => /Showing [\d,]+ of/.test(document.getElementById('filter-count')?.textContent ?? ''), null, { timeout: 600_000 });
    await quiet();
    const text = await page.locator('#filter-count').textContent();
    await row.locator('.legend-checkbox').evaluate(box => { if (!box.checked) box.click(); });
    await quiet();
    await setControl('#categorical-field', 'cell_type');
    await quiet();
    return { text };
  });

  // ---- the share lowered and raised back in place, as a person tries a
  // smaller share and returns (analyses then read genes loaded before) ----
  const roundTrip = async () => {
    const counts = [];
    const samples = [];
    const sampleBefore = await page.evaluate(() => {
      const sample = window._cellucidState.getGeneSample();
      return sample === null ? null : { cells: sample.cells, of: sample.of, limit: sample.fit?.limit ?? null };
    });
    for (const share of ['10', '100']) {
      const before = await page.evaluate(() => window._cellucidState.pointCount);
      await setControl('#subsample-percent', share);
      await (await reveal('#subsample-apply')).click();
      // Applied once the open cells are others (lowered at once, raised in
      // place over steps), then settled.
      await page.waitForFunction(n => window._cellucidState.pointCount !== n, before, { timeout: 600_000, polling: 250 });
      await page.waitForFunction(() => document.getElementById('subsample-notice')?.dataset.state !== 'growing', null, { timeout: 1_800_000, polling: 250 });
      await settled();
      await quiet();
      counts.push(await page.evaluate(() => window._cellucidState.pointCount));
      // The cells genes are read for at each share: back at every cell, the
      // sample (and fit) every cell was read for before the round trip.
      samples.push(await page.evaluate(() => {
        const sample = window._cellucidState.getGeneSample();
        return sample === null ? null : { cells: sample.cells, of: sample.of, limit: sample.fit?.limit ?? null };
      }));
    }
    return { ...(await state()), counts, sampleBefore, samples };
  };
  await step('share-round-trip', roundTrip);

  // ---- analyses -------------------------------------------------------
  // Each also after the revisit (`revisit-de`, `revisit-markers`): genes read from the index kept in this browser.
  const differential = async () => {
    await analysis('differential', { compare: 'categories', field: 'cell_type', categoriesA: { mode: 'subset', ids: ['type 0'] }, categoriesB: { mode: 'subset', ids: ['type 1'] }, method: 'wilcox', minPct: 0 }, 'Run differential expression');
    return page.evaluate(() => {
      const r = window._comparisonModule.getUI('differential')._lastResult;
      const rows = r?.full?.results ?? [];
      const top = [...rows].sort((a, b) => (a.pValue - b.pValue) || (b.log2FoldChange - a.log2FoldChange)).slice(0, 3).map(x => x.gene);
      return { genes: rows.length, top, geneSampleCells: window._cellucidState.getGeneSample()?.cells ?? null };
    }).then(detail => ({ ...detail, costsCleared }));
  };
  const markers = async () => {
    await analysis('genesPanel', { groupBy: 'cell_type' }, 'Run marker genes');
    return page.evaluate(() => {
      const r = window._comparisonModule.getUI('genesPanel')._lastResult;
      return { groups: r?.stats?.groups?.length ?? null, first: r?.selection?.groups?.[0]?.markers?.slice(0, 3).map(m => m.gene) ?? null,
        geneSampleCells: window._cellucidState.getGeneSample()?.cells ?? null };
    }).then(detail => ({ ...detail, costsCleared }));
  };
  await step('de', differential, { timeout: 1_800_000 });
  await step('markers', markers, { timeout: 1_800_000 });
  // The same page after the share is lowered and raised back (`round-trip-*`): the analyses above, again.
  await step('round-trip', roundTrip);
  await step('round-trip-de', differential, { timeout: 1_800_000 });
  await step('round-trip-markers', markers, { timeout: 1_800_000 });
  await step('signature', async () => {
    // Its cells are a highlight of two types: the field's categories loaded first (as a person picks them in its legend).
    await setControl('#categorical-field', 'cell_type');
    await page.locator('.legend-item').first().waitFor({ state: 'visible', timeout: 600_000 });
    const pageId = await page.evaluate(async () => {
      const s = window._cellucidState;
      const i = s.obsData.fields.findIndex(field => field.key === 'cell_type');
      const created = s.createHighlightPage('types 0 and 1');
      s.switchToPage(created.id);
      s.addHighlightFromCategory(i, 0, 'obs');
      s.addHighlightFromCategory(i, 1, 'obs');
      return created.id;
    });
    // The gene colored before (loaded) and two others, as a person scores genes they looked at.
    const names = await page.evaluate(shown => [...new Set([shown, ...window._cellucidState.varData.fields.slice(0, 3).map(f => f.key)])].slice(0, 3), gene);
    await analysis('signature', { geneSets: [{ name: 'markers', genes: names }] }, 'Run gene signature', { selectedPages: [pageId] });
    return page.evaluate(() => ({ sets: window._comparisonModule.getUI('signature')._lastResult?.raw?.sets?.length ?? null }));
  });
  await step('dotplot', async () => {
    const names = await page.evaluate(() => window._cellucidState.varData.fields.slice(0, 10).map(f => f.key));
    await analysis('dotplot', { groupBy: 'cell_type', geneSets: [{ name: 'markers', genes: names }] }, 'Run dot plot');
    return page.evaluate(() => { const r = window._comparisonModule.getUI('dotplot')._lastResult; return { groups: r?.data?.groups?.length ?? null, genes: r?.data?.genes?.length ?? null }; });
  });

  // ---- views, graph, velocity ----------------------------------------
  await step('multiview', async () => {
    await (await reveal('#split-keep-view-btn')).click();
    await quiet();
    const select = await reveal('#view-representation-select');
    const options = (await select.locator('option').allTextContents()).map(text => text.trim());
    const threeD = options.find(text => /3/.test(text));
    if (threeD) await setControl('#view-representation-select', threeD);
    await quiet(2500);
    return { options };
  });
  await step('edges', async () => {
    await setControl('#toggle-connectivity', true);
    // "<total> total · <visible> visible · <shown> shown", once the graph is read.
    await page.waitForFunction(() => /^[1-9][\d.]*[kM]? total/.test(document.getElementById('connectivity-info')?.textContent ?? ''), null, { timeout: 1_800_000, polling: 500 });
    await quiet(2500);
    const info = (await page.locator('#connectivity-info').textContent()).trim().slice(0, 200);
    const workingSet = await page.evaluate(async () => (await import('./assets/js/data/memory-budget.js')).memoryReport().workingSet);
    const layer = await page.evaluate(() => {
      const memory = window._cellucidViewer.getConnectivityMemoryStats();
      return { graphMB: Math.round(memory.graphBytes / 1048576), selectionMB: Math.round(memory.selectionBytes / 1048576), gpuMB: Math.round(memory.gpuBytes / 1048576) };
    }).catch(error => ({ error: String(error).slice(0, 120) }));
    return { info, workingSetMB: Object.fromEntries(Object.entries(workingSet).map(([part, bytes]) => [part, MB(bytes)])), layer, held: await heldAfterCollection(),
      snapshots: await heapSnapshots('anndata-reader-worker', `${label}-edges`) };
  });
  await step('knn', async () => {
    // The k-NN tool on the graph the edges step read: a drag from the
    // canvas center to degree 10 (30 px a degree), its rows read from the
    // file by cell; the step lands when its expansion holds the degree.
    await (await reveal('.highlight-mode-btn[data-mode="knn"]')).click();
    await page.waitForTimeout(1000);
    // A seed: the first point of a grid over the canvas a cell is drawn under
    // (with kept views the canvas is split, and its center can be a gap).
    const box = await page.locator('#glcanvas').boundingBox();
    const seed = await page.evaluate(({ left, top, width, height }) => {
      for (let row = 1; row < 12; row++) {
        for (let column = 1; column < 12; column++) {
          const x = left + (width * column) / 12;
          const y = top + (height * row) / 24;
          const record = window._cellucidViewer.pickCellRecordAtScreen(x, y);
          if (record && record.cellIndex >= 0) return { x, y, cellIndex: record.cellIndex };
        }
      }
      return null;
    }, { left: box.x, top: box.y, width: box.width, height: box.height });
    if (seed === null) throw new Error('no cell under any grid point of the canvas');
    const { x, y } = seed;
    await page.mouse.move(x, y);
    await page.keyboard.down('Alt');
    await page.mouse.down();
    const t0 = performance.now();
    for (let dy = 30; dy <= 300; dy += 30) await page.mouse.move(x, y + dy, { steps: 2 });
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await page.locator('#knn-step-controls').waitFor({ state: 'attached', timeout: 600_000 });
    const ms = Math.round(performance.now() - t0);
    const text = (await page.locator('#knn-step-controls').textContent()).trim().replace(/\s+/g, ' ').slice(0, 200);
    await page.keyboard.press('Escape');
    return { seedCell: seed.cellIndex, dragToStepMs: ms, step: text, held: await heldAfterCollection() };
  });
  await step('velocity', async () => {
    await setControl('#velocity-overlay-enabled', true);
    await page.waitForTimeout(1000);
    // Until the field has loaded: a step ended on long tasks alone left a
    // field still loading, its reads counted in the next step.
    await page.waitForFunction(() => !/^Loading/.test(document.getElementById('velocity-overlay-info')?.textContent?.trim() ?? ''), null, { timeout: 600_000 });
    await quiet(2500);
    return { info: (await page.locator('#velocity-overlay-info').textContent().catch(() => '')).trim().slice(0, 200) };
  });

  // ---- session save and restore --------------------------------------
  await step('session', async () => {
    const download = page.waitForEvent('download', { timeout: 1_800_000 });
    const t0 = performance.now();
    await (await reveal('#history-share-btn')).click();
    await page.locator('#history-share-save').click();
    const file = await download;
    const sessionPath = path.join(downloads, 'session.cellucid-session');
    await file.saveAs(sessionPath);
    const saveMs = Math.round(performance.now() - t0);
    const chooser = page.waitForEvent('filechooser');
    const t1 = performance.now();
    await (await reveal('#history-load-btn')).click();
    await page.locator('#load-state-btn').click();
    await (await chooser).setFiles(sessionPath);
    await page.waitForTimeout(1000);
    await settled();
    await quiet(2500);
    return { saveMs, restoreMs: Math.round(performance.now() - t1), bytes: statSync(sessionPath).size };
  });

  // ---- exports --------------------------------------------------------
  await step('figure', async () => {
    // A PNG of the view (the format a person exports a large dataset in),
    // edges and velocity off first (a figure draws the point layer only).
    // Each control is waited for, never passed over by a timed-out
    // optional call: one such call held every PNG step 30 s.
    const result = await figure('png');
    return { ...result, failure: null };
  }, { timeout: 300_000 });
  await step('cells', async () => {
    await page.evaluate(() => {
      const s = window._cellucidState;
      s.ensureHighlightPage();
      const picked = new Uint32Array(1000);
      for (let i = 0; i < picked.length; i++) picked[i] = i * 7;
      s.addHighlightDirect({ type: 'annotation', label: 'picked', cellIndices: picked });
    });
    const download = page.waitForEvent('download', { timeout: 1_800_000 });
    await (await reveal('#export-highlights-csv')).click();
    const file = await download;
    const target = path.join(downloads, file.suggestedFilename());
    await file.saveAs(target);
    return { file: file.suggestedFilename(), bytes: statSync(target).size };
  }, { timeout: 180_000 });

  // ---- a revisit: the same link again in the same profile, to its first gene
  await step('revisit', async () => {
    await page.close();
    page = await context.newPage();
    watchPage(page);
    const t0 = performance.now();
    const since = errors.length;
    await page.goto(pageAddress(), { waitUntil: 'domcontentloaded' });
    await opened(0, since);
    const firstFrameMs = Math.round(performance.now() - t0);
    const settledMs = Math.round((await settled()) - t0);
    const gene1 = await colorGene(gene);
    const geneMs = Math.round(performance.now() - t0);
    await quiet();
    return { firstFrameMs, settledMs, geneMs, gene: gene1, ...(await state()) };
  }, { timeout: 1_800_000 });
  await step('revisit-de', differential, { timeout: 1_800_000 });
  await step('revisit-markers', markers, { timeout: 1_800_000 });

  // ---- Apply 10% -----------------------------------------------------
  await step('apply-10', async () => {
    await setControl('#subsample-percent', '10');
    await (await reveal('#subsample-apply')).click();
    await page.waitForTimeout(500);
    await settled();
    await quiet();
    return state();
  });
} finally {
  clearInterval(sampler);
  try { ws.close(); } catch { /* closed */ }
  // Each close bounded: a browser holding gigabytes can take long to close,
  // and the run ends regardless (its process tree is killed after).
  const bounded = (promise, ms) => Promise.race([promise.catch(() => {}), new Promise(resolve => setTimeout(resolve, ms).unref())]);
  await bounded(browser.close(), 20_000);
  try { process.kill(rootPid, 'SIGKILL'); } catch { /* gone */ }
  app.kill();
  storeServer.closeAllConnections?.();
  storeServer.close();
  // Nothing else is waited for: the results are written step by step.
  process.exit(process.exitCode ?? 0);
}
