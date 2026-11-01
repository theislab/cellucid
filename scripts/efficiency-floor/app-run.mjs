/**
 * The whole app reading one dataset from this machine, in one engine, as a
 * person opens it: a file or folder picked with File... / Folder...
 * (`--file`, `--folder`), a server on loopback (`--server`: `cellucid serve`,
 * `cellucid_serve`, `efficiency-floor/served.py` / `served.R`) or a link
 * (`--data`, e.g. a folder served by any web host on loopback). Steps: the
 * first picture (with the requests sent to the data's host before it), every
 * cell asked for, the first gene, another gene, 100 genes at once, and a
 * differential-expression read (50 genes over ~13 % of the cells the gene
 * sample holds), each timed inside the page; the browser's peak resident
 * memory; on a failure, the page's last console lines and 5xx answers.
 *
 *   node scripts/efficiency-floor/app-run.mjs --engine chromium|firefox|webkit
 *     (--file PATH | --folder PATH | --server URL | --data URL) [--cells 10%]
 *     [--sample uniform|blocks] [--visits N] [--label NAME] [--out results.jsonl] [--port 4651]
 *
 * `--visits N` opens the same link N times in the same browser profile, one
 * after another (a revisit: what the first visit kept in this browser
 * counts), each visit's steps under `visits[i]` (the first also as `steps`).
 *
 * Run it alone (`heavy.sh`): it starts a browser on the machine's GPU
 * (`lib/browser-launch.mjs`; the renderer it drew with is in the result, and a software one
 * refuses the run) and the app's test server on `--port` and the next one.
 */
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserLaunchOptions, requireHardwareRenderer } from '../lib/browser-launch.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(REPO, 'package.json'));
const pw = require('playwright');
const arg = (n, d = null) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const engine = arg('--engine', 'chromium');
const file = arg('--file'); const folder = arg('--folder'); const server = arg('--server'); const data = arg('--data');
const cells = arg('--cells', null);
const sample = arg('--sample', null);
const visits = Math.max(1, Number(arg('--visits', '1')));
const label = arg('--label', path.basename(file ?? folder ?? server ?? data));
const out = arg('--out');
const appPort = Number(arg('--port', '4651'));
// A failure outside the steps (a rejection nothing awaited) is said, not lost.
process.on('unhandledRejection', reason => { console.error(`unhandled rejection: ${String(reason?.stack ?? reason).slice(0, 800)}`); });
function residentBytes(rootPid) {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n').map(l => l.trim().split(/\s+/).map(Number));
  const kids = new Map(); for (const [p, pp] of rows) { if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push(p); }
  const rss = new Map(rows.map(([p, , kb]) => [p, kb * 1024]));
  let total = 0; const stack = [...(kids.get(rootPid) ?? [])];
  while (stack.length) { const p = stack.pop(); total += rss.get(p) ?? 0; stack.push(...(kids.get(p) ?? [])); }
  return total;
}
const app = spawn(process.execPath, [path.join(REPO, 'scripts', 'serve-browser-tests.mjs')], { cwd: REPO,
  env: { ...process.env, CELLUCID_BROWSER_TEST_PORT: String(appPort), CELLUCID_BROWSER_TEST_SAMPLE_PORT: String(appPort + 1) }, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1500));
const browser = await pw[engine].launch(browserLaunchOptions(engine));
const result = { label, engine, cells, sample, steps: {}, visits: [] };
let peak = 0;
const sampler = setInterval(() => { try { peak = Math.max(peak, residentBytes(process.pid)); } catch {} }, 200);
// Held outside the steps: a failure reports the page's last lines.
const errors = [];
const consoleLines = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { consoleLines.push(`${m.type()}: ${m.text()}`.slice(0, 300)); if (consoleLines.length > 400) consoleLines.shift(); });
  page.on('response', r => { if (r.status() >= 500 && consoleLines.length < 1000) consoleLines.push(`HTTP ${r.status()} ${r.url().slice(-120)}`); });
  for (let visit = 0; visit < visits; visit++) {
  const steps = visit === 0 ? result.steps : {};
  result.visits.push(steps);
  const url = new URL(`http://127.0.0.1:${appPort}/`);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  result.renderer ??= await requireHardwareRenderer(page);
  if (server) { url.searchParams.set('source', 'remote'); url.searchParams.set('remote', server); url.searchParams.set('anndata', 'true'); }
  if (data) url.searchParams.set('data', data);
  // Requests to the data's host (a server or a link), and those before the first picture.
  const dataOrigin = server ? new URL(server).origin : data ? new URL(data).origin : null;
  let dataRequests = 0;
  page.on('request', r => { if (dataOrigin !== null && r.url().startsWith(dataOrigin)) dataRequests++; });
  if (cells) url.searchParams.set('cells', cells);
  if (sample) url.searchParams.set('sample', sample);
  let t0;
  let shownBefore = null;
  if (server || data) {
    t0 = performance.now();
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  } else {
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    const input = page.locator(file ? '#user-data-file-input' : '#user-data-folder-input');
    await input.waitFor({ state: 'attached' });
    await page.waitForFunction(id => !document.getElementById(id).disabled, file ? 'user-data-file-input' : 'user-data-folder-input', { timeout: 120000 });
    const inputEvent = await input.evaluateHandle(node => ({ promise: new Promise(resolve => node.addEventListener('input', () => resolve(), { once: true })) }));
    // A dataset already shown (a sample the start page opened) is not the
    // one asked for: its name is recorded, and the file's replacing it timed.
    shownBefore = await page.evaluate(() => document.getElementById('dataset-name')?.textContent.trim() ?? '');
    t0 = performance.now();
    await Promise.race([input.setInputFiles(file ?? folder), inputEvent.evaluate(event => event.promise)]);
  }
  const first = await page.waitForFunction(prior => {
    const s = window._cellucidState;
    const name = document.getElementById('dataset-name')?.textContent.trim() ?? '';
    return (s?.pointCount ?? 0) > 0 && (prior === null || (name !== '' && name !== prior && !/opening/i.test(name))) ? s.pointCount : null;
  }, shownBefore, { timeout: 900000, polling: 50 }).then(h => h.jsonValue());
  steps.firstPicture = { ms: Math.round(performance.now() - t0), cells: first, requests: dataRequests };
  // Every cell asked for: the page starts a progressive opening's growth
  // after its first picture's UI sync, so a notice not yet growing right
  // after it says nothing. Settled: not growing, and the open cells
  // unchanged for two seconds.
  await page.waitForFunction(() => {
    const now = { count: window._cellucidState?.pointCount ?? 0, at: performance.now() };
    const last = window.__appRunSettle ?? null;
    if (document.getElementById('subsample-notice')?.dataset.state === 'growing' || last === null || last.count !== now.count) {
      window.__appRunSettle = now;
      return false;
    }
    return now.at - last.at >= 2000;
  }, null, { timeout: 900000, polling: 100 }).catch(() => {});
  await page.evaluate(() => { delete window.__appRunSettle; });
  const count = await page.evaluate(() => window._cellucidState.pointCount);
  steps.allCells = { ms: Math.round(performance.now() - t0), cells: count };
  await page.waitForFunction(() => window._comparisonModule?.dataLayer?.getAvailableVariables('gene_expression')?.length > 0, null, { timeout: 120000 });
  // Timed from here: the page's policy refuses JavaScript evaluation
  // (`new Function`), so each step runs as Playwright sends a function.
  const timed = async (name, fn, argument) => {
    const t = performance.now();
    const v = await page.evaluate(fn, argument);
    steps[name] = { ms: Math.round(performance.now() - t), info: v ?? null };
  };
  await timed('firstGene', async () => { const g = window._comparisonModule.dataLayer.getAvailableVariables('gene_expression'); await window._comparisonModule.colorByGene(g[13 % g.length].key); return g[13 % g.length].key; });
  await timed('nextGene', async () => { const g = window._comparisonModule.dataLayer.getAvailableVariables('gene_expression'); await window._comparisonModule.colorByGene(g[977 % g.length].key); return g[977 % g.length].key; });
  await timed('genes100', async () => { const g = window._comparisonModule.dataLayer.getAvailableVariables('gene_expression'); const keys = Array.from({ length: Math.min(100, g.length) }, (_, i) => g[(i * 7919 + 101) % g.length].key); const r = await window._comparisonModule.dataLayer.readGeneColumns(keys); return keys.length; });
  await timed('deRead', async () => { const dl = window._comparisonModule.dataLayer; const g = dl.getAvailableVariables('gene_expression'); const keys = Array.from({ length: Math.min(50, g.length) }, (_, i) => g[(i * 104729 + 7) % g.length].key); const sample = window._cellucidState.getGeneSample?.() ?? null; const n = sample === null ? window._cellucidState.pointCount : sample.cells; const cells = []; for (let i = 0; i < n; i++) if (i % 15 < 2) cells.push(i); await dl.readGeneCellSubset(keys, cells); return { genes: keys.length, cells: cells.length }; });
  if (out) appendFileSync(out, JSON.stringify({ label, engine, cells, sample, visit, steps }) + '\n');
  }
  result.errors = errors.slice(0, 5);
  // The page's last console lines on request (`APP_RUN_CONSOLE=1`), as on a failure.
  if (process.env.APP_RUN_CONSOLE === '1') result.console = consoleLines.slice(-80);
} catch (error) {
  result.error = String(error.stack ?? error).slice(0, 800);
  result.console = consoleLines.slice(-80);
} finally {
  clearInterval(sampler);
  result.peakBrowserMB = Math.round(peak / 1e6);
  await browser.close();
  app.kill();
}
console.log(JSON.stringify(result));
if (out) appendFileSync(out, JSON.stringify(result) + '\n');
