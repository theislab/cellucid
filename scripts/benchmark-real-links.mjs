/**
 * Real datasets, real hosts, the real app: how long Cellucid takes to open a
 * linked dataset and show it, and how much it downloads, with the current
 * readers and (with `--baseline`) with an earlier revision's.
 *
 *   node scripts/benchmark-real-links.mjs [--baseline REF] [--links data1,data2]
 *     [--query "&cells=1%"] [--open-only]
 *     [--timeout-s 600] [--browser-args --use-angle=metal] [--out results.json]
 *
 * Each implementation is the whole app, served from its own checkout (the
 * earlier one from a temporary worktree, removed afterwards) on its own port.
 * Every link opens in a fresh browser context (empty HTTP cache), one at a
 * time, in Chromium. Steps, each timed and with the bytes and requests the
 * Transfers log counted for it:
 *
 * 1. open: from navigation to a ready view of the dataset;
 * 2. colour by a categorical field (the second one the field menu lists);
 * 3. show a gene (the first of the gene list).
 *
 * 4. show another gene.
 *
 * A progressive opening (a first view of fewer cells, grown in place to the
 * cells asked for: `app/open-cells-resize.js`) adds a step after 1, "grown
 * to every cell asked for", and records the first view's cells
 * (`firstViewCells`).
 *
 * A step that does not finish within `--timeout-s` is recorded as timed out,
 * and the link's later steps are skipped.
 *
 * Local files, over a simulated link: `--serve DIR` serves DIR (HTTP range
 * requests, CORS) through one shared link of `--link-latency` ms and
 * `--link-bandwidth` MB/s (0: unthrottled, as a fast local network), over
 * `--link-protocol` `http/1.1` (the default: six connections) or `h2` (one
 * TLS connection, a self-signed certificate the browser is told to accept),
 * and `{serve}` in a link names it. To compare two AnnData files of one
 * dataset (as written, and as `cellucid.prepare()` writes it):
 *
 *   node scripts/benchmark-real-links.mjs --serve DIR --link-latency 80 --link-bandwidth 20 \
 *     --links "{serve}/suo.h5ad,{serve}/suo_prepared.h5ad"
 *
 * Files on this computer, as a person opens them: `{local}/ABS/PATH` picks
 * the file (or the folder, for a path that is one) with the app's File… or
 * Folder… button, after the app has started on its test catalog.
 *
 * Each step also reports the peak memory of the browser's processes
 * (resident set, sampled every 100 ms) and the page's main-thread long
 * tasks (count, longest, total).
 *
 * `--again`: each link is opened a second time in a new page of the same
 * browser profile, after the first page is closed: a later visit, with what
 * the first kept in this browser's storage (a file read whole: an R object,
 * a MatrixMarket folder, a file its host serves only whole), reported as
 * `<implementation> again`. The profile is a fresh one on disk per link (a
 * persistent context): an incognito context's storage quota is a share of
 * memory, too small for a large file read whole.
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import http from 'node:http';
import http2 from 'node:http2';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(HERE, '..');
const require = createRequire(path.join(REPOSITORY, 'package.json'));
const { chromium } = require('playwright');

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

/** Links of the data-loading documentation, small to atlas-sized. */
const DEFAULT_LINKS = [
  'cellxgene:a49d9109-1d0c-4b36-8139-19aa9a83428c',
  'gh:theislab/cellucid-demo-custom-datasets/files/synthetic-cell-types-2d.zarr.zip',
  'https://www.dropbox.com/s/qj1jlm9w10wmt0u/pancreas.h5ad?dl=1',
  'zenodo:14730926/cs9_scRNA_annotation.h5ad',
  'hf:datavil/pbmc3k',
  'zenodo:10850398/liao20_sub.h5ad',
  'geo:GSE350831/GSE350831_Flex_pilot_paper_annotated_bbknn.h5ad',
  'geo:GSE327505',
  'cellxgene:c5d88abe-f23a-45fa-a534-788985e93dad',
  'cellxgene:9f222629-9e39-47d0-b83f-e08d610c7479',
];

const SERVE_PORT = 4395;
const serveRoot = argument('--serve');
const linkLatencyMs = Number(argument('--link-latency', '0'));
const linkBytesPerMs = Number(argument('--link-bandwidth', '0')) * 1e6 / 1000;
const linkProtocol = argument('--link-protocol', 'http/1.1');
if (linkProtocol !== 'http/1.1' && linkProtocol !== 'h2') throw new Error('--link-protocol is http/1.1 or h2');
const links = (argument('--links') ?? DEFAULT_LINKS.join(','))
  .split(',')
  .map(link => link.replaceAll('{serve}', `${linkProtocol === 'h2' ? 'https' : 'http'}://127.0.0.1:${SERVE_PORT}`));
const timeoutMs = Number(argument('--timeout-s', '600')) * 1000;
const baseline = argument('--baseline');
const out = argument('--out');
// What the link asks for besides the dataset (`--query "&cells=1%"`: a
// subsample, `app/subsample-url.js`), and whether to stop once it is open
// (`--open-only`: the opening and its growth, no field or gene steps).
const query = argument('--query') ?? '';
const openOnly = process.argv.includes('--open-only');
// Extra Chromium switches, comma-separated: `--browser-args --use-angle=metal`
// renders on the Mac's GPU through Metal.
const browserArgs = (argument('--browser-args') ?? '').split(',').filter(Boolean);

function serve(root, port) {
  // The test server also binds a sample port; each server gets its own.
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'serve-browser-tests.mjs')], {
    cwd: root,
    env: { ...process.env, CELLUCID_BROWSER_TEST_PORT: String(port), CELLUCID_BROWSER_TEST_SAMPLE_PORT: String(port + 100) },
    stdio: 'ignore',
  });
  return child;
}

/**
 * DIR over one simulated link: every response waits for the link's latency
 * and for its bytes to pass after everything sent before it, as on a
 * shared connection.
 */
function serveFiles(root) {
  let linkFreeAt = 0;
  const handler = async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Range');
    response.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, ETag');
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }
    const target = path.join(root, decodeURIComponent(new URL(request.url, 'http://x').pathname));
    let stat;
    try {
      stat = statSync(target);
      if (stat.isDirectory()) throw new Error('directory');
    } catch {
      response.writeHead(404).end();
      return;
    }
    const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '');
    const start = range ? Number(range[1]) : 0;
    const end = range ? Math.min(stat.size, range[2] === '' ? stat.size : Number(range[2]) + 1) : stat.size;
    const headers = {
      'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start),
      ETag: `"${stat.size}-${stat.mtimeMs}"`,
    };
    if (range) headers['Content-Range'] = `bytes ${start}-${end - 1}/${stat.size}`;
    const length = request.method === 'HEAD' ? 0 : end - start;
    const now = performance.now();
    const sendAt = Math.max(now + linkLatencyMs, linkFreeAt) + (linkBytesPerMs > 0 ? length / linkBytesPerMs : 0);
    linkFreeAt = linkBytesPerMs > 0 ? sendAt : linkFreeAt;
    const bytes = Buffer.alloc(length);
    if (length > 0) {
      const handle = await openFile(target, 'r');
      try {
        await handle.read(bytes, 0, length, start);
      } finally {
        await handle.close();
      }
    }
    setTimeout(() => {
      response.writeHead(range ? 206 : 200, headers);
      response.end(bytes);
    }, Math.max(0, sendAt - performance.now()));
  };
  let server;
  if (linkProtocol === 'h2') {
    const folder = mkdtempSync(path.join(tmpdir(), 'cellucid-h2-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=127.0.0.1', '-days', '1',
      '-keyout', path.join(folder, 'key.pem'), '-out', path.join(folder, 'cert.pem')], { stdio: 'ignore' });
    server = http2.createSecureServer({
      key: readFileSync(path.join(folder, 'key.pem')),
      cert: readFileSync(path.join(folder, 'cert.pem')),
      allowHTTP1: false,
    }, handler);
    rmSync(folder, { recursive: true, force: true });
  } else {
    server = http.createServer(handler);
  }
  server.listen(SERVE_PORT, '127.0.0.1');
  return server;
}

/** The resident memory of this process's descendants (the browser), in bytes. */
function browserResidentBytes() {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n')
    .map(line => line.trim().split(/\s+/).map(Number));
  const children = new Map();
  for (const [pid, ppid] of rows) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const rss = new Map(rows.map(([pid, , kb]) => [pid, kb * 1024]));
  let total = 0;
  const stack = [...(children.get(process.pid) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop();
    total += rss.get(pid) ?? 0;
    stack.push(...(children.get(pid) ?? []));
  }
  return total;
}

/** The page's main-thread long tasks, collected from the first script on. */
const LONG_TASKS = () => {
  window.__benchLongTasks = [];
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) window.__benchLongTasks.push(entry.duration);
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    // An engine without longtask entries.
  }
};

async function waitForServer(port) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`The server on port ${port} did not start.`);
}

/** Bytes and requests the Transfers log has counted so far. */
const transferTotals = page => page.evaluate(async () => {
  const { getTransferLog } = await import('/assets/js/data/transfer-log.js');
  return getTransferLog().entries().reduce(
    (sum, entry) => ({ bytes: sum.bytes + entry.bytes, requests: sum.requests + entry.requests }),
    { bytes: 0, requests: 0 }
  );
});

const longTasksSoFar = page => page.evaluate(() => window.__benchLongTasks?.length ?? 0).catch(() => 0);

async function measure(page, label, action, steps) {
  const before = await transferTotals(page).catch(() => ({ bytes: 0, requests: 0 }));
  const tasksBefore = await longTasksSoFar(page);
  let peakBytes = browserResidentBytes();
  const sampler = setInterval(() => {
    peakBytes = Math.max(peakBytes, browserResidentBytes());
  }, 100);
  const started = performance.now();
  let outcome = 'ok';
  try {
    await action();
  } catch (error) {
    outcome = /Timeout/i.test(error.message) ? 'timed out' : `failed: ${error.message.split('\n')[0]}`;
  } finally {
    clearInterval(sampler);
  }
  const seconds = Math.round((performance.now() - started) / 100) / 10;
  const after = await transferTotals(page).catch(() => before);
  const tasks = await page.evaluate(from => (window.__benchLongTasks ?? []).slice(from), tasksBefore).catch(() => []);
  steps.push({
    step: label,
    seconds,
    bytes: after.bytes - before.bytes,
    requests: after.requests - before.requests,
    peakMB: Math.round(Math.max(peakBytes, browserResidentBytes()) / 1e6),
    longTasks: { count: tasks.length, maxMs: Math.round(Math.max(0, ...tasks)), totalMs: Math.round(tasks.reduce((sum, ms) => sum + ms, 0)) },
    outcome,
  });
  return outcome === 'ok';
}

/** The app started on its test catalog, ready for a file of this computer (not measured). */
async function startForLocal(page, port, target) {
  const catalog = encodeURIComponent(`http://127.0.0.1:${port}/tests/browser/fixtures/catalog/`);
  await page.goto(`http://127.0.0.1:${port}/?sampleCatalog=${catalog}&dataset=current-ui`);
  const input = statSync(target).isDirectory() ? '#user-data-folder-input' : '#user-data-file-input';
  await page.waitForFunction(selector => {
    const element = document.querySelector(selector);
    return element !== null && !element.disabled && document.documentElement.dataset.startupPhase === 'ready' &&
      (document.getElementById('dataset-name')?.textContent.trim() ?? '') !== '';
  }, input, { timeout: timeoutMs, polling: 100 });
  if (await page.locator('#welcome-modal').isVisible()) {
    await page.keyboard.press('Escape');
    await page.locator('#welcome-modal').waitFor({ state: 'hidden' });
  }
  return input;
}

/** Open a file or folder on this computer with the app's File… or Folder… button. */
async function openLocal(page, input, target) {
  const before = (await page.textContent('#dataset-name')).trim();
  await page.locator(input).setInputFiles(target);
  await page.waitForFunction(previous => {
    const shown = document.getElementById('dataset-name')?.textContent.trim() ?? '';
    return shown !== '' && shown !== previous && !/opening/i.test(shown);
  }, before, { timeout: timeoutMs, polling: 100 });
}

const again = process.argv.includes('--again');

async function runLink(browser, port, data) {
  const options = { viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: linkProtocol === 'h2' };
  const profile = again ? mkdtempSync(path.join(tmpdir(), 'cellucid-profile-')) : null;
  const context = profile === null
    ? await browser.newContext(options)
    : await chromium.launchPersistentContext(profile, { ...options, args: browserArgs });
  await context.addInitScript(LONG_TASKS);
  try {
    const first = await runLinkIn(context, port, data);
    if (!again) return [first];
    return [first, { ...(await runLinkIn(context, port, data)), again: true }];
  } finally {
    await context.close();
    if (profile !== null) rmSync(profile, { recursive: true, force: true });
  }
}

async function runLinkIn(context, port, data) {
  const page = await context.newPage();
  const steps = [];
  const result = { data, steps, name: null, cells: null };
  try {
    const local = data.startsWith('{local}') ? data.slice('{local}'.length) : null;
    const input = local === null ? null : await startForLocal(page, port, local);
    const opened = await measure(page, 'open', async () => {
      if (local !== null) {
        await openLocal(page, input, local);
        return;
      }
      await page.goto(`http://127.0.0.1:${port}/?data=${encodeURIComponent(data)}${query}`);
      await page.waitForFunction(() => {
        if (document.getElementById('cellucid-startup-failure')) throw new Error('refused');
        const failed = document.querySelector('.opening-overlay[data-state="failed"]:not([hidden])');
        if (failed !== null) throw new Error(`refused: ${failed.textContent.trim().slice(0, 300)}`);
        const name = document.getElementById('dataset-name')?.textContent.trim() ?? '';
        return document.documentElement.dataset.startupPhase === 'ready' && name !== '' && name !== '–' && name !== '—' &&
          document.getElementById('dataset-info')?.dataset.state === 'ready';
      }, null, { timeout: timeoutMs, polling: 250 });
    }, steps);
    if (!opened) return result;
    // A progressive opening (`app/open-cells-resize.js`) showed a first view
    // of fewer cells: the time until every cell asked for is open, read as
    // it grows in place.
    result.firstViewCells = await page.evaluate(() => window._cellucidState?.pointCount ?? null);
    if (await page.evaluate(() => /^Reading the cells asked for/.test(document.getElementById('subsample-notice')?.textContent ?? ''))) {
      await measure(page, 'grown to every cell asked for', async () => {
        await page.waitForFunction(
          () => !/^Reading the cells asked for/.test(document.getElementById('subsample-notice')?.textContent ?? ''),
          null,
          { timeout: timeoutMs, polling: 250 }
        );
      }, steps);
    }
    result.name = (await page.textContent('#dataset-name')).trim();
    result.cells = (await page.textContent('#dataset-cells')).trim();
    if (openOnly) return result;
    const field = await page.evaluate(() => {
      const options = [...document.querySelectorAll('#categorical-field option')].map(option => option.value).filter(Boolean);
      return options[1] ?? options[0] ?? null;
    });
    if (field !== null) {
      await measure(page, 'colour by a field', async () => {
        await page.locator('#categorical-field').selectOption(field);
        await page.waitForFunction(value => {
          const state = window._cellucidState;
          const active = state?.activeFieldSource === 'obs' ? state.obsData?.fields?.[state.activeFieldIndex] : null;
          return document.getElementById('categorical-field')?.value === value &&
            active != null && (active.codes != null || active.values != null);
        }, field, { timeout: timeoutMs, polling: 250 });
      }, steps);
    }
    const genes = await page.evaluate(() => (window._cellucidState?.varData?.fields ?? []).slice(0, 2).map(field => field.key));
    for (const [index, gene] of genes.entries()) {
      await measure(page, index === 0 ? 'show a gene' : 'show another gene', async () => {
        const search = page.locator('#gene-expression-search');
        // The panel holding the search may start collapsed.
        await search.evaluate(element => {
          for (let node = element.closest('details'); node !== null; node = node.parentElement?.closest('details') ?? null) node.open = true;
        });
        await search.click();
        await search.fill(gene);
        await search.press('Enter');
        await page.waitForFunction(name => {
          const state = window._cellucidState;
          return state?.activeFieldSource === 'var' &&
            state.varData.fields[state.activeVarFieldIndex]?.key === name &&
            state.varData.fields[state.activeVarFieldIndex].values != null;
        }, gene, { timeout: timeoutMs, polling: 250 });
      }, steps);
    }
  } finally {
    await page.close();
  }
  return result;
}

const servers = [];
let worktreeParent = null;
const implementations = [['current', REPOSITORY, 4191]];
if (baseline !== null) {
  worktreeParent = mkdtempSync(path.join(tmpdir(), 'cellucid-real-links-'));
  const baselineRoot = path.join(worktreeParent, 'baseline');
  execFileSync('git', ['-C', REPOSITORY, 'worktree', 'add', '--detach', baselineRoot, baseline], { stdio: 'ignore' });
  implementations.unshift(['earlier', baselineRoot, 4193]);
}
const results = [];
const fileServer = serveRoot === null ? null : serveFiles(path.resolve(serveRoot));
const browser = await chromium.launch({ args: browserArgs });
try {
  for (const [, root, port] of implementations) {
    servers.push(serve(root, port));
    await waitForServer(port);
  }
  for (const data of links) {
    for (const [implementation, , port] of implementations) {
      for (const run of await runLink(browser, port, data)) {
        const label = run.again ? `${implementation} again` : implementation;
        const result = { implementation: label, ...run };
        results.push(result);
        const summary = result.steps.map(step =>
          `${step.step} ${step.seconds} s, ${(step.bytes / 1e6).toFixed(1)} MB, ${step.requests} req, peak ${step.peakMB} MB, ` +
          `long tasks ${step.longTasks.count} (max ${step.longTasks.maxMs} ms)${step.outcome === 'ok' ? '' : ` (${step.outcome})`}`).join(' | ');
        console.log(`${label.padEnd(8)} ${data}\n         ${result.name ?? ''} ${result.cells ?? ''} cells | ${summary}`);
      }
    }
  }
} finally {
  await browser.close();
  fileServer?.close();
  for (const server of servers) server.kill();
  if (worktreeParent !== null) {
    execFileSync('git', ['-C', REPOSITORY, 'worktree', 'remove', '--force', path.join(worktreeParent, 'baseline')], { stdio: 'ignore' });
    rmSync(worktreeParent, { recursive: true, force: true });
  }
}
if (out !== null) {
  writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), baseline, timeoutMs, results }, null, 2));
}
