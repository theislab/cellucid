/**
 * The scale check's browser axes: the whole app (Chromium) opening one
 * store by link at a share (`&cells=`), measured from navigation to the first
 * frame of the cells asked for: the time, the bytes the page fetched, the
 * peak resident memory of the browser's processes, and the GPU memory the
 * renderer reports holding (`viewer.getRendererStats(view).gpuMemoryMB`).
 *
 *   node scripts/efficiency-floor/scale-browser.mjs STORE [--cells 10%,100%] [--out results.jsonl]
 *
 * The app is served by `serve-browser-tests.mjs` on this lane's ports
 * (`CELLUCID_BROWSER_TEST_PORT`, default 4573); the store from its folder
 * on the next port, over loopback (a fast network: the axes measured here are
 * time, memory and GPU, the bytes are the Node runs'). Run it alone
 * (`heavy.sh`): it starts a browser.
 */

import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(HERE, '..', '..');
const require = createRequire(path.join(REPOSITORY, 'package.json'));
const { chromium } = require('playwright');

const store = path.resolve(process.argv[2]);
const argument = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const shares = argument('--cells', '10%,100%').split(',');
const out = argument('--out', null);
const appPort = Number(process.env.CELLUCID_BROWSER_TEST_PORT ?? 4573);
const storePort = appPort + 3;

function residentBytes(rootPid) {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const children = new Map();
  for (const [pid, ppid] of rows) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const rss = new Map(rows.map(([pid, , kb]) => [pid, kb * 1024]));
  let total = 0;
  const stack = [...(children.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop();
    total += rss.get(pid) ?? 0;
    stack.push(...(children.get(pid) ?? []));
  }
  return total;
}

// The store, with ranges and CORS, as a web host serves it.
const storeServer = createServer((request, response) => {
  const file = path.join(path.dirname(store), decodeURIComponent(new URL(request.url, 'http://x').pathname));
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length, ETag, Accept-Ranges', 'Accept-Ranges': 'bytes' };
  if (request.method === 'OPTIONS') { response.writeHead(204, headers).end(); return; }
  let size;
  try { size = statSync(file).size; } catch { response.writeHead(404, headers).end(); return; }
  headers.ETag = `"${size}"`;
  const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '');
  if (request.method === 'HEAD' && range === null) { response.writeHead(200, { ...headers, 'Content-Length': size }).end(); return; }
  const start = range ? Number(range[1]) : 0;
  const end = range && range[2] !== '' ? Math.min(size - 1, Number(range[2])) : size - 1;
  response.writeHead(range ? 206 : 200, { ...headers, 'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
  if (request.method === 'HEAD') { response.end(); return; }
  createReadStream(file, { start, end }).pipe(response);
});
await new Promise(resolve => storeServer.listen(storePort, '127.0.0.1', resolve));
const app = spawn(process.execPath, [path.join(REPOSITORY, 'scripts', 'serve-browser-tests.mjs')], {
  cwd: REPOSITORY,
  env: { ...process.env, CELLUCID_BROWSER_TEST_PORT: String(appPort), CELLUCID_BROWSER_TEST_SAMPLE_PORT: String(appPort + 1) },
  stdio: 'ignore',
});
await new Promise(resolve => setTimeout(resolve, 1500));

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
try {
  for (const cells of shares) {
    const context = await browser.newContext();
    const page = await context.newPage();
    let fetched = 0;
    // Bytes of the store's GET answers (a probe's HEAD declares the whole
    // file's length and carries none).
    page.on('response', response => {
      if (response.request().method() !== 'GET') return;
      const length = Number(response.headers()['content-length'] ?? 0);
      if (response.url().startsWith(`http://127.0.0.1:${storePort}/`)) fetched += length;
    });
    const link = `http://127.0.0.1:${storePort}/${encodeURIComponent(path.basename(store))}`;
    let peak = 0;
    const sampler = setInterval(() => { peak = Math.max(peak, residentBytes(process.pid)); }, 100);
    const started = performance.now();
    await page.goto(`http://127.0.0.1:${appPort}/?data=${encodeURIComponent(link)}&cells=${encodeURIComponent(cells)}`);
    const expected = await page.waitForFunction(() => {
      const state = window._cellucidState;
      const subset = state?.cellSubset ?? null;
      const count = state?.pointCount ?? 0;
      return count > 0 ? { count } : null;
    }, null, { timeout: 900000, polling: 100 }).then(handle => handle.jsonValue());
    const firstFrameMs = performance.now() - started;
    // Every cell asked for (a progressive opening grows to them).
    await page.waitForFunction(() => !/^Reading the cells asked for/.test(document.getElementById('subsample-notice')?.textContent ?? ''), null, { timeout: 900000, polling: 250 }).catch(() => {});
    const allMs = performance.now() - started;
    await page.waitForTimeout(1000);
    const gpu = await page.evaluate(() => {
      const viewer = window._cellucidViewer;
      const view = viewer?.getActiveViewId?.() ?? 'live';
      try {
        return { mb: viewer.getRendererStats(view)?.gpuMemoryMB ?? null, points: window._cellucidState?.pointCount ?? null };
      } catch (error) {
        return { mb: null, error: String(error), points: window._cellucidState?.pointCount ?? null };
      }
    });
    clearInterval(sampler);
    const result = { store: path.basename(store), cells, firstFrameCells: expected.count, openCells: gpu.points, firstFrameMs: Math.round(firstFrameMs), allCellsMs: Math.round(allMs), fetchedMB: Math.round(fetched / 1e5) / 10, peakBrowserMB: Math.round(peak / 1e6), gpuMemoryMB: gpu.mb === null ? null : Math.round(gpu.mb), gpuError: gpu.error ?? null };
    console.log(JSON.stringify(result));
    if (out !== null) appendFileSync(out, `${JSON.stringify(result)}\n`);
    await context.close();
  }
} finally {
  await browser.close();
  app.kill();
  storeServer.close();
}
