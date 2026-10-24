/**
 * The analysis benchmark: marker genes and differential expression on a real
 * dataset, in Chromium, over an unshaped and a shaped link.
 *
 *   npm run bench:analysis -- [--root DIR] [--data DIR] [--dataset ID]
 *     [--profiles none,4g] [--flows markers-cell_type,...] [--reps 5]
 *     [--configs FILE.json] [--order interleaved|grouped] [--out FILE.jsonl]
 *
 * `--root` is the app that is measured (default: this repository). Measure a
 * committed revision by checking it out into a temporary worktree and passing
 * that folder. `--data` is a folder with a sample catalog (`datasets.json`),
 * default `../cellucid-datasets/anndata`; `--dataset` the id opened from it
 * (default `suo`).
 *
 * Flows:
 *   markers-cell_type   marker genes on `cell_type`
 *   markers-sample_ID   marker genes on `sample_ID`
 *   de-lvl1-pages       DE between the two largest `LVL1` categories as pages
 *   de-lvl1-rest        DE of the largest `LVL1` category against the others
 *
 * `--configs` is a JSON array of `{ label, markers?, de? }`: the objects are
 * merged into the marker run's and the DE call's options. Without it one
 * configuration, `auto`, runs each call with the app's own choices.
 *
 * Profiles: `none` serves the files as fast as the machine reads them; `4g`
 * holds every response one 170 ms round trip and shares a 9 Mbit/s bucket
 * between all of them (WebPageTest's 4G). Both are HTTP/2 over TLS, as a
 * dataset host serves them; the certificate is a throwaway made per run.
 *
 * Every measurement opens the dataset in a fresh browser context (cold
 * caches: a user's first run); the opening is not measured. Each flow
 * records its wall time, the main thread's long tasks (> 50 ms:
 * count, longest, all durations), the page's peak JS heap above its idle
 * level (sampled every 25 ms after a forced collection), and the run's
 * tuning record when the result carries one (`metadata.tuning`). One JSON
 * row per flow and repetition is printed and appended to `--out`.
 *
 * One heavy job at a time on the machine: nothing else may run while this
 * measures.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, createReadStream, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import http2 from 'node:http2';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(HERE, '..');

function argument(name, otherwise = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? otherwise : process.argv[index + 1];
}

const ROOT = path.resolve(argument('--root', REPOSITORY));
const DATA = path.resolve(argument('--data', path.join(REPOSITORY, '..', 'cellucid-datasets', 'anndata')));
const DATASET = argument('--dataset', 'suo');
const PROFILE_NAMES = argument('--profiles', 'none,4g').split(',');
const FLOWS = argument('--flows', 'markers-cell_type,markers-sample_ID,de-lvl1-pages,de-lvl1-rest').split(',');
const REPS = Number(argument('--reps', '1'));
const ORDER = argument('--order', 'interleaved');
const OUT = argument('--out');
const CONFIGS_FILE = argument('--configs');
const CONFIGS = CONFIGS_FILE === null
  ? [{ label: 'auto' }]
  : JSON.parse(readFileSync(CONFIGS_FILE, 'utf8'));
const LABEL = argument('--label', '');
const PORT = Number(argument('--port', '47791'));

if (!Number.isSafeInteger(REPS) || REPS < 1) throw new RangeError('--reps must be a positive integer');
if (!Array.isArray(CONFIGS) || CONFIGS.some(c => typeof c?.label !== 'string')) {
  throw new TypeError('--configs must be a JSON array of { label, markers?, de? }');
}

// WebPageTest connectivity profiles: downstream bit/s and round trip.
const PROFILES = {
  none: null,
  '4g': { down: 9e6, rtt: 170 },
};

const TYPES = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
};

function createShaper(profile) {
  const shape = PROFILES[profile];
  if (shape === undefined) throw new RangeError(`Unknown profile ${profile}`);
  const stats = { requests: 0, bytes: 0 };
  let nextFree = 0;
  return {
    stats,
    reset() { stats.requests = 0; stats.bytes = 0; },
    async roundTrip() { if (shape) await new Promise(r => setTimeout(r, shape.rtt)); },
    async take(bytes) {
      if (!shape) return;
      const now = performance.now();
      const start = Math.max(now, nextFree);
      nextFree = start + (bytes * 8 / shape.down) * 1000;
      const wait = nextFree - now;
      if (wait > 1) await new Promise(r => setTimeout(r, wait));
    },
  };
}

function serve({ root, port, key, cert, shaper, cors }) {
  const server = http2.createSecureServer({
    key, cert, allowHTTP1: true,
    settings: { maxConcurrentStreams: 256 },
    maxSessionMemory: 1024,
  });
  server.on('request', async (req, res) => {
    const base = cors ? {
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'content-length, content-range, etag, accept-ranges',
    } : {};
    res.on('error', () => {});
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...base, 'access-control-allow-methods': 'GET, HEAD', 'access-control-allow-headers': '*', 'access-control-max-age': '600' });
      res.end();
      return;
    }
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'https://x').pathname); } catch { res.writeHead(400, base); res.end(); return; }
    let file = path.join(root, pathname);
    if (!file.startsWith(root)) { res.writeHead(403, base); res.end(); return; }
    let st;
    try {
      st = statSync(file);
      if (st.isDirectory()) { file = path.join(file, 'index.html'); st = statSync(file); }
      if (!st.isFile()) throw new Error('not a file');
    } catch {
      if (shaper) { shaper.stats.requests++; await shaper.roundTrip(); }
      if (!res.destroyed) { res.writeHead(404, base); res.end(); }
      return;
    }
    if (shaper) { shaper.stats.requests++; await shaper.roundTrip(); }
    if (res.destroyed || res.stream?.destroyed) return;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    const start = range === null ? 0 : Number(range[1]);
    const end = range === null || range[2] === '' ? st.size - 1 : Math.min(Number(range[2]), st.size - 1);
    if (range !== null && start > end) {
      res.writeHead(416, { ...base, 'content-range': `bytes */${st.size}` });
      res.end();
      return;
    }
    res.writeHead(range === null ? 200 : 206, {
      ...base,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'content-length': end - start + 1,
      'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      ...(range === null ? {} : { 'content-range': `bytes ${start}-${end}/${st.size}` }),
    });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = createReadStream(file, { start, end, highWaterMark: 16384 });
    try {
      for await (const chunk of stream) {
        if (shaper) await shaper.take(chunk.length);
        if (shaper) shaper.stats.bytes += chunk.length;
        if (res.destroyed) { stream.destroy(); return; }
        if (!res.write(chunk)) await new Promise(r => res.once('drain', r));
      }
      res.end();
    } catch {
      stream.destroy();
      if (!res.destroyed) res.destroy();
    }
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// The flow, run in the page. `extra` is the configuration's options for the
// call the flow makes.
async function runFlow({ flow, config }) {
  const cm = window._comparisonModule;
  const state = cm.state;
  const dataLayer = cm.dataLayer;

  const categoryField = async key => {
    const fieldIndex = state.obsData.fields.findIndex(f => f.key === key);
    if (fieldIndex < 0) throw new Error(`No obs field ${key}`);
    const field = await dataLayer.ensureObsFieldLoaded(key, { silent: true });
    const counts = new Map();
    for (const code of field.codes) counts.set(code, (counts.get(code) ?? 0) + 1);
    const missing = field.codes.BYTES_PER_ELEMENT === 1 ? 255 : field.codes.BYTES_PER_ELEMENT === 2 ? 65535 : 4294967295;
    counts.delete(missing);
    const bySize = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([code]) => code);
    return { fieldIndex, bySize };
  };
  const makePage = (name, fieldIndex, codes) => {
    const created = state.createHighlightPage(name);
    state.switchToPage(created.id);
    for (const code of codes) state.addHighlightFromCategory(fieldIndex, code, 'obs');
    return created.id;
  };

  let call;
  if (flow.startsWith('markers-')) {
    const obsCategory = flow.slice('markers-'.length);
    const { GenesPanelController } = await import('/assets/js/app/analysis/genes-panel/genes-panel-controller.js');
    const { MARKER_OPTIONS: schema } = await import('/assets/js/app/analysis/options/marker-options.js');
    call = async () => {
      const controller = new GenesPanelController({ dataLayer });
      try {
        const options = schema.withDefaults(
          { groupBy: obsCategory, ...(config.markers ?? {}) },
          { categoricalFields: [{ key: obsCategory }], pages: [], geneFamilyCounts: {}, hasHighlyVariable: false },
        );
        return await controller.runAnalysis({ options });
      } finally {
        await controller.close();
      }
    };
  } else if (flow === 'de-lvl1-pages' || flow === 'de-lvl1-rest') {
    window.__benchPages ??= {};
    if (window.__benchPages[flow] === undefined) {
      const { fieldIndex, bySize } = await categoryField('LVL1');
      window.__benchPages[flow] = flow === 'de-lvl1-pages'
        ? { a: makePage('bench A', fieldIndex, [bySize[0]]), b: makePage('bench B', fieldIndex, [bySize[1]]) }
        : { a: makePage('bench largest', fieldIndex, [bySize[0]]), b: makePage('bench rest', fieldIndex, bySize.slice(1)) };
    }
    const { a, b } = window.__benchPages[flow];
    const mva = cm.multiVariableAnalysis;
    const groups = { groupA: mva.pageGroup(a), groupB: mva.pageGroup(b) };
    call = () => mva.differentialExpression({ ...groups, method: 'wilcox', ...(config.de ?? {}) });
  } else {
    throw new Error(`Unknown flow ${flow}`);
  }

  // Idle heap after a collection, then the peak during the run.
  globalThis.gc?.();
  await new Promise(r => setTimeout(r, 200));
  const idleHeap = performance.memory.usedJSHeapSize;
  let peakHeap = idleHeap;
  const sampler = setInterval(() => {
    const used = performance.memory.usedJSHeapSize;
    if (used > peakHeap) peakHeap = used;
  }, 25);
  const longTasks = [];
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) longTasks.push(Math.round(entry.duration));
  });
  observer.observe({ type: 'longtask' });

  const t0 = performance.now();
  let result;
  let error = null;
  try {
    result = await call();
  } catch (e) {
    error = String(e?.message ?? e).slice(0, 400);
  }
  const ms = Math.round(performance.now() - t0);
  await new Promise(r => setTimeout(r, 100));
  observer.disconnect();
  clearInterval(sampler);
  const tuning = result?.metadata?.tuning ?? result?.tuning ?? null;
  return {
    ms,
    error,
    longTasks: longTasks.length,
    longTaskMax: longTasks.length ? Math.max(...longTasks) : 0,
    longTaskList: longTasks,
    peakHeapMB: +((peakHeap - idleHeap) / 2 ** 20).toFixed(1),
    tuning,
    genes: Array.isArray(result?.results) ? result.results.length : (result?.metadata?.geneCount ?? result?.markers?.geneCount ?? null),
  };
}

const scratch = mkdtempSync(path.join(tmpdir(), 'cellucid-analysis-bench-'));
const keyPath = path.join(scratch, 'key.pem');
const certPath = path.join(scratch, 'cert.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '2', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
const key = readFileSync(keyPath);
const cert = readFileSync(certPath);

const emit = row => {
  const line = JSON.stringify({ label: LABEL, dataset: DATASET, ...row });
  console.log(line);
  if (OUT !== null) appendFileSync(OUT, `${line}\n`);
};

try {
  for (const profile of PROFILE_NAMES) {
    const shaper = createShaper(profile);
    const appServer = await serve({ root: ROOT, port: PORT, key, cert, shaper: null, cors: false });
    const dataServer = await serve({ root: DATA, port: PORT + 1, key, cert, shaper, cors: true });
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--ignore-certificate-errors',
        '--use-angle=metal',
        '--enable-precise-memory-info',
        '--js-flags=--expose-gc',
      ],
    });
    // Open the dataset in a fresh context: nothing read before is cached.
    const openPage = async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true });
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', e => pageErrors.push(e.message));
      const t0 = Date.now();
      shaper.reset();
      const url = new URL(`https://127.0.0.1:${PORT}/`);
      url.searchParams.set('sampleCatalog', `https://127.0.0.1:${PORT + 1}/`);
      url.searchParams.set('dataset', DATASET);
      await page.goto(url.toString());
      await page.locator('#welcome-modal').waitFor({ state: 'visible', timeout: 60000 }).catch(() => {});
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => (window._comparisonModule?.state?.pointCount ?? 0) > 0, null, { timeout: 900000, polling: 500 });
      // The default view's own loads settle first: three quiet seconds on the
      // data link.
      for (let waited = 0, last = -1; waited < 240000; waited += 3000) {
        if (shaper.stats.requests === last) break;
        last = shaper.stats.requests;
        await page.waitForTimeout(3000);
      }
      // A still picture: an animated highlight redraws every frame, which in
      // headless GL is main-thread work the analysis would be charged for.
      await page.evaluate(() => window._cellucidViewer?.setShaderQuality?.('light'));
      return { context, page, pageErrors, openMs: Date.now() - t0 };
    };

    try {
      const schedule = [];
      if (ORDER === 'grouped') {
        for (const config of CONFIGS) for (let rep = 0; rep < REPS; rep++) for (const flow of FLOWS) schedule.push({ config, flow, rep });
      } else {
        for (let rep = 0; rep < REPS; rep++) for (const config of CONFIGS) for (const flow of FLOWS) schedule.push({ config, flow, rep });
      }
      let first = true;
      for (const { config, flow, rep } of schedule) {
        // Every run is a user's first: a fresh page, cold caches. The
        // dataset's opening is not part of the measurement.
        const { context, page, pageErrors, openMs } = await openPage();
        if (first) {
          const environment = await page.evaluate(() => ({
            cores: navigator.hardwareConcurrency,
            deviceMemory: navigator.deviceMemory ?? null,
            heapLimitMB: Math.round(performance.memory.jsHeapSizeLimit / 2 ** 20),
            userAgent: navigator.userAgent,
          }));
          emit({ profile, flow: 'open', ms: openMs, environment });
          first = false;
        }
        shaper.reset();
        const row = await page.evaluate(runFlow, { flow, config }).catch(e => ({ error: String(e.message).slice(0, 400) }));
        emit({ profile, flow, config: config.label, rep, ...row, requests: shaper.stats.requests, MB: +(shaper.stats.bytes / 1e6).toFixed(2), ...(pageErrors.length ? { pageErrors: pageErrors.slice(0, 3) } : {}) });
        await context.close();
      }
    } finally {
      await browser.close();
      await new Promise(r => appServer.close(r));
      await new Promise(r => dataServer.close(r));
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

