/**
 * Real datasets, real hosts, the real app: how long Cellucid takes to open a
 * linked dataset and show it, and how much it downloads, with the current
 * readers and (with `--baseline`) with an earlier revision's.
 *
 *   node scripts/benchmark-real-links.mjs [--baseline REF] [--links data1,data2]
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
 * A step that does not finish within `--timeout-s` is recorded as timed out,
 * and the link's later steps are skipped.
 *
 * Local files, over a simulated link: `--serve DIR` serves DIR (HTTP range
 * requests, CORS) through one shared link of `--link-latency` ms and
 * `--link-bandwidth` MB/s (0: unthrottled, as a fast local network), and
 * `{serve}` in a link names it. To compare two AnnData files of one dataset
 * (as written, and as `cellucid.prepare()` writes it):
 *
 *   node scripts/benchmark-real-links.mjs --serve DIR --link-latency 80 --link-bandwidth 20 \
 *     --links "{serve}/suo.h5ad,{serve}/suo_prepared.h5ad"
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
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
const links = (argument('--links') ?? DEFAULT_LINKS.join(','))
  .split(',')
  .map(link => link.replaceAll('{serve}', `http://127.0.0.1:${SERVE_PORT}`));
const timeoutMs = Number(argument('--timeout-s', '600')) * 1000;
const baseline = argument('--baseline');
const out = argument('--out');
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
  const server = http.createServer((request, response) => {
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
    const bytes = Buffer.alloc(request.method === 'HEAD' ? 0 : end - start);
    if (bytes.length > 0) {
      const fd = openSync(target, 'r');
      readSync(fd, bytes, 0, bytes.length, start);
    }
    const now = performance.now();
    const sendAt = Math.max(now + linkLatencyMs, linkFreeAt) + (linkBytesPerMs > 0 ? bytes.length / linkBytesPerMs : 0);
    linkFreeAt = linkBytesPerMs > 0 ? sendAt : linkFreeAt;
    setTimeout(() => {
      response.writeHead(range ? 206 : 200, headers);
      response.end(bytes);
    }, Math.max(0, sendAt - now));
  });
  server.listen(SERVE_PORT, '127.0.0.1');
  return server;
}

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

async function measure(page, label, action, steps) {
  const before = await transferTotals(page).catch(() => ({ bytes: 0, requests: 0 }));
  const started = performance.now();
  let outcome = 'ok';
  try {
    await action();
  } catch (error) {
    outcome = /Timeout/i.test(error.message) ? 'timed out' : `failed: ${error.message.split('\n')[0]}`;
  }
  const after = await transferTotals(page).catch(() => before);
  steps.push({
    step: label,
    seconds: Math.round((performance.now() - started) / 100) / 10,
    bytes: after.bytes - before.bytes,
    requests: after.requests - before.requests,
    outcome,
  });
  return outcome === 'ok';
}

async function runLink(browser, port, data) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const steps = [];
  const result = { data, steps, name: null, cells: null };
  try {
    const opened = await measure(page, 'open', async () => {
      await page.goto(`http://127.0.0.1:${port}/?data=${encodeURIComponent(data)}`);
      await page.waitForFunction(() => {
        if (document.getElementById('cellucid-startup-failure')) throw new Error('refused');
        const name = document.getElementById('dataset-name')?.textContent.trim() ?? '';
        return document.documentElement.dataset.startupPhase === 'ready' && name !== '' && name !== '–' && name !== '—';
      }, null, { timeout: timeoutMs, polling: 250 });
    }, steps);
    if (!opened) return result;
    result.name = (await page.textContent('#dataset-name')).trim();
    result.cells = (await page.textContent('#dataset-cells')).trim();
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
    await context.close();
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
      const result = { implementation, ...(await runLink(browser, port, data)) };
      results.push(result);
      const summary = result.steps.map(step =>
        `${step.step} ${step.seconds} s, ${(step.bytes / 1e6).toFixed(1)} MB, ${step.requests} req${step.outcome === 'ok' ? '' : ` (${step.outcome})`}`).join(' | ');
      console.log(`${implementation.padEnd(8)} ${data}\n         ${result.name ?? ''} ${result.cells ?? ''} cells | ${summary}`);
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
