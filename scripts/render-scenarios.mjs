#!/usr/bin/env node
/**
 * Render and interaction scenarios: the measurement driver of wave W0 of the
 * render-performance plan (cellucid-private/plans/render-performance-audit.md).
 *
 * Each scenario loads the real application in one browser, installs the
 * render probes (`assets/js/app/ui/modules/benchmark/render-probes.js`) on the
 * live viewer, drives one feature the way a user does, and writes what the
 * probes saw:
 *
 *   - frames drawn per cause and idle wake-ups (`frames`);
 *   - per-pass draws, ranges, vertices, instances and, with --timing, GPU ms
 *     (`passes`);
 *   - uploads and synchronous stalls (`uploads`);
 *   - input-to-frame latency per input type (`inputs`);
 *   - long tasks (`longTasks`);
 *   - JS heap and renderer GPU bytes before and after (`memory`).
 *
 * Scenarios: idle, filter, smoke, velocity, edges, selection, session, export.
 *
 *   node scripts/render-scenarios.mjs --scenarios smoke,export --points 1000000
 *   node scripts/render-scenarios.mjs --engine firefox --scenarios selection
 *   node scripts/render-scenarios.mjs --list
 *
 * Options:
 *   --scenarios a,b      scenarios to run (default: all, in the order above)
 *   --engine name        chromium (default), firefox or webkit
 *   --points N           synthetic cloud size for synthetic sources (200000)
 *   --pattern name       synthetic pattern (clusters)
 *   --views N            views (1..4) for the scenarios that honour it (1)
 *   --culling mode       lod+frustum (default), lod, frustum or none: adaptive
 *                        LOD and frustum culling, set after the data loads
 *   --antialias on|off   force antialiasing (default: the app's own choice)
 *   --quality name       point shader quality (full, sculpted, light,
 *                        ultralight; default: the app's own)
 *   --timing / --no-timing  per-pass GPU timer queries (default on where the
 *                        engine exposes them; frame times of a timed window are
 *                        perturbed by the queries)
 *   --source spec        override every scenario's data source:
 *                        synthetic | fixture | demo:<id> | export:<baseUrl>#<id>
 *   --data-root dir      also serve <dir> at /__data/ (for export:/__data/…#id)
 *   --idle-ms N          length of idle windows (2000)
 *   --orbit-frames N     frames of orbit windows (120)
 *   --out file           JSON output (test-results/render-scenarios/…json)
 *   --port N             loopback port (47931)
 *   --dpr N              device scale factor (1)
 *   --headed             show the browser
 *   --force              skip the machine-quietness check
 *
 * Machine rules (16 GB development machines): one heavy job at a time. The
 * driver refuses to start while another Playwright, benchmark or stress
 * process runs, or while macOS reports under 40% free memory, unless --force.
 * It runs one engine, one page at a time, and closes every browser it opened.
 */

import { execSync } from 'node:child_process';
import { createReadStream, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, firefox, webkit } from '@playwright/test';

import { openCollapsedPanels } from '../tests/browser/helpers/panels.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBES_MODULE = '/assets/js/app/ui/modules/benchmark/index.js';
const FIXTURE_EXPORTS = '/tests/browser/fixtures/exports/';
const DEMO_EXPORTS = '/tests/browser/fixtures/demo-custom-exports/';
const FIXTURE_DATASET = 'current-ui-prepared';
const DEMO_3D_DATASET = 'synthetic-development-3d';
const VIEWPORT = Object.freeze({ width: 1440, height: 1000 });
const SCENARIO_ORDER = Object.freeze([
  'idle',
  'filter',
  'smoke',
  'velocity',
  'edges',
  'selection',
  'session',
  'export'
]);
/** What each scenario measures on when --source does not override it. */
const DEFAULT_SOURCES = Object.freeze({
  idle: 'synthetic',
  filter: 'synthetic',
  smoke: 'synthetic',
  velocity: `demo:${DEMO_3D_DATASET}`,
  edges: `demo:${DEMO_3D_DATASET}`,
  selection: 'fixture',
  session: 'fixture',
  // A prepared fixture, so the figure carries a legend and axes; a synthetic
  // cloud (--source synthetic --points N) measures export at any size.
  export: 'fixture'
});
const MIN_FREE_MEMORY_PERCENT = 40;
const CONTENT_TYPES = new Map([
  ['.bin', 'application/octet-stream'],
  ['.css', 'text/css; charset=utf-8'],
  ['.f32', 'application/octet-stream'],
  ['.glb', 'model/gltf-binary'],
  ['.gz', 'application/gzip'],
  ['.h5ad', 'application/x-hdf5'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/vnd.microsoft.icon'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.u8', 'application/octet-stream'],
  ['.u16', 'application/octet-stream'],
  ['.wasm', 'application/wasm'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.xml', 'application/xml; charset=utf-8'],
  ['.zarr', 'application/octet-stream'],
  ['.zip', 'application/zip'],
  ['.cff', 'text/plain; charset=utf-8']
]);

// ------------------------------------------------------------------ options

function parseArguments(argv) {
  const options = {
    scenarios: [...SCENARIO_ORDER],
    engine: 'chromium',
    points: 200_000,
    pattern: 'clusters',
    views: 1,
    culling: 'lod+frustum',
    timing: null,
    source: null,
    dataRoot: null,
    idleMs: 2000,
    orbitFrames: 120,
    out: null,
    port: 47931,
    dpr: 1,
    headed: false,
    force: false,
    list: false
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${flag} needs a value.`);
      return next;
    };
    switch (flag) {
      case '--scenarios': options.scenarios = value().split(',').filter(Boolean); break;
      case '--engine': options.engine = value(); break;
      case '--points': options.points = Number(value()); break;
      case '--pattern': options.pattern = value(); break;
      case '--views': options.views = Number(value()); break;
      case '--culling': options.culling = value(); break;
      case '--antialias': options.antialias = value(); break;
      case '--quality': options.quality = value(); break;
      case '--timing': options.timing = true; break;
      case '--no-timing': options.timing = false; break;
      case '--source': options.source = value(); break;
      case '--data-root': options.dataRoot = path.resolve(value()); break;
      case '--idle-ms': options.idleMs = Number(value()); break;
      case '--orbit-frames': options.orbitFrames = Number(value()); break;
      case '--out': options.out = path.resolve(value()); break;
      case '--port': options.port = Number(value()); break;
      case '--dpr': options.dpr = Number(value()); break;
      case '--headed': options.headed = true; break;
      case '--force': options.force = true; break;
      case '--list': options.list = true; break;
      default: throw new Error(`Unknown option ${flag}; see the header of ${path.basename(fileURLToPath(import.meta.url))}.`);
    }
  }
  for (const scenario of options.scenarios) {
    if (!SCENARIO_ORDER.includes(scenario)) {
      throw new Error(`Unknown scenario "${scenario}"; one of ${SCENARIO_ORDER.join(', ')}.`);
    }
  }
  if (!['chromium', 'firefox', 'webkit'].includes(options.engine)) {
    throw new Error('--engine must be chromium, firefox or webkit.');
  }
  if (!Number.isSafeInteger(options.points) || options.points < 1) {
    throw new Error('--points must be a positive whole number.');
  }
  if (!Number.isSafeInteger(options.views) || options.views < 1 || options.views > 4) {
    throw new Error('--views must be 1 to 4.');
  }
  if (!['lod+frustum', 'lod', 'frustum', 'none'].includes(options.culling)) {
    throw new Error('--culling must be lod+frustum, lod, frustum or none.');
  }
  if (options.antialias !== undefined && !['on', 'off'].includes(options.antialias)) {
    throw new Error('--antialias must be on or off.');
  }
  if (options.quality !== undefined && !['full', 'sculpted', 'light', 'ultralight'].includes(options.quality)) {
    throw new Error('--quality must be full, sculpted, light or ultralight.');
  }
  return options;
}

// ------------------------------------------------------------------ machine

function assertQuietMachine() {
  const ownPid = process.pid;
  const rows = execSync('ps -axo pid=,command=', { encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const match = /^(\d+)\s+(.*)$/.exec(line);
      return match ? { pid: Number(match[1]), command: match[2] } : null;
    })
    .filter(Boolean);
  const heavy = rows.filter(row =>
    row.pid !== ownPid &&
    /playwright|bench|stress/i.test(row.command) &&
    !/render-scenarios\.mjs|\bgrep\b|crashpad|mcp/i.test(row.command)
  );
  if (heavy.length > 0) {
    throw new Error(
      'Another heavy job is running (one at a time on this machine):\n' +
      heavy.slice(0, 8).map(row => `  ${row.pid} ${row.command.slice(0, 140)}`).join('\n') +
      '\nRe-run when it has finished, or pass --force.'
    );
  }
  if (os.platform() === 'darwin') {
    let output = '';
    try {
      output = execSync('memory_pressure', { encoding: 'utf8' });
    } catch {
      return;
    }
    const match = /free percentage:\s*(\d+)%/i.exec(output);
    if (match && Number(match[1]) < MIN_FREE_MEMORY_PERCENT) {
      throw new Error(
        `Only ${match[1]}% of memory is free (needs ${MIN_FREE_MEMORY_PERCENT}%). ` +
        'Re-run when the machine is quieter, or pass --force.'
      );
    }
  }
}

// ------------------------------------------------------------------ server

function startServer(port, dataRoot) {
  const server = createServer((request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    if (pathname === '/') pathname = '/index.html';
    let root = REPOSITORY_ROOT;
    if (dataRoot !== null && pathname.startsWith('/__data/')) {
      root = dataRoot;
      pathname = pathname.slice('/__data'.length);
    }
    const file = path.resolve(root, `.${pathname}`);
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      response.writeHead(403);
      response.end();
      return;
    }
    let stat;
    try {
      stat = statSync(file);
    } catch {
      response.writeHead(404, { 'Cache-Control': 'no-store' });
      response.end('Not Found');
      return;
    }
    if (!stat.isFile()) {
      response.writeHead(404, { 'Cache-Control': 'no-store' });
      response.end('Not Found');
      return;
    }
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Length': stat.size,
      'Content-Type': CONTENT_TYPES.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream'
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    createReadStream(file).pipe(response);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// ------------------------------------------------------------------ browser

function launchBrowser(engine, headed) {
  if (engine === 'chromium') {
    const args = ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-precise-memory-info'];
    if (os.platform() === 'darwin') args.push('--use-angle=metal');
    return chromium.launch({ headless: !headed, args });
  }
  if (engine === 'firefox') {
    return firefox.launch({
      headless: !headed,
      firefoxUserPrefs: {
        'webgl.disabled': false,
        'webgl.enable-webgl2': true,
        'webgl.forbid-software': false,
        'webgl.force-enabled': true
      }
    });
  }
  return webkit.launch({ headless: !headed });
}

function sourceUrl(origin, source) {
  const encode = value => encodeURIComponent(new URL(value, origin).href);
  if (source === 'synthetic' || source === 'fixture') {
    return `/?exportsBaseUrl=${encode(FIXTURE_EXPORTS)}&dataset=${FIXTURE_DATASET}`;
  }
  if (source.startsWith('demo:')) {
    return `/?exportsBaseUrl=${encode(DEMO_EXPORTS)}&dataset=${encodeURIComponent(source.slice(5))}`;
  }
  if (source.startsWith('export:')) {
    const spec = source.slice(7);
    const hash = spec.lastIndexOf('#');
    if (hash < 0) throw new Error('--source export:<baseUrl>#<datasetId>');
    return `/?exportsBaseUrl=${encode(spec.slice(0, hash))}&dataset=${encodeURIComponent(spec.slice(hash + 1))}`;
  }
  throw new Error(`Unknown source "${source}".`);
}

async function dismissWelcomeIfShown(page) {
  const modal = page.locator('#welcome-modal');
  try {
    await modal.waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    return;
  }
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden', timeout: 15_000 });
}

async function waitFor(page, predicate, argument, timeoutMs, description) {
  try {
    await page.waitForFunction(predicate, argument, { timeout: timeoutMs, polling: 100 });
  } catch (error) {
    throw new Error(`Timed out after ${timeoutMs} ms waiting for ${description}: ${error.message}`);
  }
}

async function publishSynthetic(page, count, pattern) {
  await page.evaluate(() => {
    const section = document.getElementById('benchmark-section');
    if (section instanceof HTMLDetailsElement) section.open = true;
  });
  await page.locator('#benchmark-count').fill(String(count));
  await page.locator('#benchmark-pattern').selectOption(pattern);
  await waitFor(page, () => !document.getElementById('benchmark-run')?.disabled, null, 60_000, 'the benchmark panel');
  await page.locator('#benchmark-run').click();
  await waitFor(
    page,
    expected => window._cellucidState?.pointCount === expected,
    count,
    600_000,
    `the synthetic cloud of ${count} points`
  );
}

async function loadSource(page, origin, source, options) {
  await page.goto(`${origin}${sourceUrl(origin, source)}`, { waitUntil: 'domcontentloaded' });
  await dismissWelcomeIfShown(page);
  await waitFor(
    page,
    () => (window._cellucidState?.pointCount ?? 0) > 0 && typeof window._cellucidViewer === 'object',
    null,
    300_000,
    'the dataset'
  );
  if (source === 'synthetic') await publishSynthetic(page, options.points, options.pattern);
  await openCollapsedPanels(page);
}

async function installProbes(page, timing) {
  return page.evaluate(async ({ moduleUrl, timing: wantTiming }) => {
    const harness = await import(moduleUrl);
    const viewer = window._cellucidViewer;
    const canvas = document.getElementById('glcanvas');
    const gl = canvas.getContext('webgl2');
    const identity = harness.readRendererIdentity(gl);
    const probes = harness.installRenderProbes({ viewer, canvas, timing: wantTiming });
    window.__renderScenario = { harness, probes, windows: new Map(), viewer };
    return {
      identity: JSON.parse(JSON.stringify(identity)),
      rasterizer: JSON.parse(JSON.stringify(harness.classifyRasterizer(identity))),
      timing: probes.passes.timing,
      multiDrawInstrumented: probes.uploads.multiDrawInstrumented,
      longTaskSource: probes.longTasks.source,
      pointCount: window._cellucidState.pointCount,
      devicePixelRatio: window.devicePixelRatio
    };
  }, { moduleUrl: PROBES_MODULE, timing });
}

/** Open a probe window in the page, run `body` from Node, close it. */
async function measured(page, label, body, { settle = true, settleTimeoutMs = 60_000 } = {}) {
  await page.evaluate(name => {
    const scenario = window.__renderScenario;
    scenario.windows.set(name, scenario.probes.openWindow(name));
  }, label);
  let error = null;
  try {
    await body();
  } catch (caught) {
    error = caught;
  }
  const record = await page.evaluate(async ({ name, wantSettle, timeoutMs }) => {
    const scenario = window.__renderScenario;
    let settleTimedOut = false;
    if (wantSettle) {
      try {
        await scenario.probes.waitForSettled({ timeoutMs });
      } catch {
        settleTimedOut = true;
      }
    }
    const token = scenario.windows.get(name);
    scenario.windows.delete(name);
    const result = await scenario.probes.closeWindow(token);
    result.settleTimedOut = settleTimedOut;
    return result;
  }, { name: label, wantSettle: settle && error === null, timeoutMs: settleTimeoutMs });
  if (error !== null) throw error;
  return record;
}

/** An idle window of `ms` milliseconds. */
function idleWindow(page, label, ms) {
  return measured(page, label, () => page.waitForTimeout(ms), { settle: false });
}

/** An orbit window of `frames` frames. */
function orbitWindow(page, label, frames) {
  return measured(
    page,
    label,
    () => page.evaluate(count => window.__renderScenario.probes.orbit(count), frames),
    { settle: false }
  );
}

async function setRange(page, selector, value) {
  await page.evaluate(([target, next]) => {
    const input = document.querySelector(target);
    if (!input) throw new Error(`Missing control ${target}`);
    input.value = String(next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, [selector, value]);
}

async function settle(page, timeoutMs = 60_000) {
  await page.evaluate(ms => window.__renderScenario.probes.waitForSettled({ timeoutMs: ms }), timeoutMs);
}

async function ensureViews(page, views) {
  if (views <= 1) return 1;
  for (let view = 1; view < views; view++) {
    const before = await page.evaluate(() => window._cellucidViewer.getSnapshotViews().length);
    await page.locator('#split-keep-view-btn').click();
    await waitFor(
      page,
      count => window._cellucidViewer.getSnapshotViews().length > count,
      before,
      120_000,
      `kept view ${view}`
    );
  }
  // The layout control sits in a panel that may be collapsed: set it as the
  // control's own change handler would see it.
  await page.evaluate(() => {
    const select = document.getElementById('view-layout-mode');
    select.value = 'grid';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitFor(page, () => window._cellucidViewer.getViewLayout().mode === 'grid', null, 30_000, 'the grid layout');
  return page.evaluate(() => window._cellucidViewer.getSnapshotViews().length + 1);
}

async function colourByFirstCategory(page, preferredLabel = null) {
  const chosen = await page.evaluate(preferred => {
    const select = document.getElementById('categorical-field');
    if (!(select instanceof HTMLSelectElement)) return null;
    const options = [...select.options].filter(option =>
      option.value !== '' && option.value !== '-1' && !option.disabled);
    const option = options.find(candidate => candidate.textContent.trim() === preferred) ?? options[0];
    if (!option) return null;
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return option.textContent.trim();
  }, preferredLabel);
  if (chosen === null) return null;
  await waitFor(
    page,
    () => window._cellucidState.getActiveField?.()?.kind === 'category' &&
      document.querySelectorAll('.legend-item .legend-checkbox').length > 0,
    null,
    60_000,
    'the categorical field'
  );
  return chosen;
}

/**
 * A measured in-page interaction. The page is served under a strict CSP, so
 * actions and conditions are named entries of the registries below rather than
 * source strings: `action` is `[name, ...args]`, `until` is `[name, ...args]`
 * or null.
 */
function interaction(page, label, action, until = null, extra = {}) {
  return page.evaluate(async ({ name, actionSpec, untilSpec, options }) => {
    const scenario = window.__renderScenario;
    const actions = {
      selectValue(selector, value) {
        const select = document.querySelector(selector);
        if (!select) throw new Error(`Missing control ${selector}`);
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      },
      click(selector) {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`Missing control ${selector}`);
        element.click();
      },
      check(selector) {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`Missing control ${selector}`);
        if (!element.checked) element.click();
      },
      setRange(selector, value) {
        const input = document.querySelector(selector);
        if (!input) throw new Error(`Missing control ${selector}`);
        input.value = value === 'max' ? input.max : value === 'min' ? input.min : String(value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      },
      toggleRange(selector, low, high) {
        const input = document.querySelector(selector);
        if (!input) throw new Error(`Missing control ${selector}`);
        input.value = String(Number(input.value) >= (low + high) / 2 ? low : high);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    };
    const conditions = {
      passEntered(passLabel, startedAt) {
        const entered = scenario.probes.passes.lastEnteredAt(passLabel);
        return entered !== null && entered > startedAt;
      },
      smokeReady(startedAt) {
        return conditions.passEntered('smoke-march', startedAt) &&
          !scenario.viewer.hasPendingSmokeNoiseGeneration();
      }
    };
    const [actionName, ...actionArgs] = actionSpec;
    if (typeof actions[actionName] !== 'function') throw new Error(`Unknown action ${actionName}`);
    let until;
    if (untilSpec !== null) {
      const [conditionName, ...conditionArgs] = untilSpec;
      if (typeof conditions[conditionName] !== 'function') {
        throw new Error(`Unknown condition ${conditionName}`);
      }
      const startedAt = performance.now();
      until = () => conditions[conditionName](...conditionArgs, startedAt);
    }
    return scenario.probes.measureInteraction(
      name,
      () => actions[actionName](...actionArgs),
      { ...options, until }
    );
  }, { name: label, actionSpec: action, untilSpec: until, options: extra });
}

// ------------------------------------------------------------------ scenarios

const SCENARIOS = {
  async idle(page, options) {
    const views = await ensureViews(page, options.views);
    await settle(page);
    return {
      views,
      steps: [
        await idleWindow(page, 'idle', options.idleMs),
        await orbitWindow(page, 'orbit', options.orbitFrames),
        await idleWindow(page, 'after-orbit', options.idleMs)
      ]
    };
  },

  /**
   * What a filter costs: one tick (the transparency publication), and the
   * orbit frames before any filter, while 70% of cells are visible, and once
   * every cell is visible again -- the per-vertex cost of drawing through the
   * alpha lookup, in every view.
   */
  async filter(page, options) {
    const views = await ensureViews(page, options.views);
    await settle(page);
    const steps = [await orbitWindow(page, 'orbit-unfiltered', options.orbitFrames)];
    const setVisibility = fraction => page.evaluate(visibleFraction => {
      const viewer = window._cellucidViewer;
      const n = viewer.getPointCount();
      const alpha = new Uint8Array(n);
      const keep = Math.round(visibleFraction * 1000);
      for (let index = 0; index < n; index++) {
        alpha[index] = (((index * 2654435761) >>> 0) % 1000) < keep ? 1 : 0;
      }
      viewer.updateTransparency(alpha);
      for (const snapshot of viewer.getSnapshotViews()) {
        viewer.updateSnapshotAttributes(snapshot.id, { transparency: alpha });
      }
    }, fraction);
    steps.push(await measured(page, 'filter-tick', () => setVisibility(0.7)));
    steps.push(await orbitWindow(page, 'orbit-filtered', options.orbitFrames));
    steps.push(await measured(page, 'unfilter-tick', () => setVisibility(1)));
    steps.push(await orbitWindow(page, 'orbit-all-visible', options.orbitFrames));
    return { views, steps };
  },

  async smoke(page, options) {
    // Smoke is refused while kept views exist; it always runs in one view.
    await settle(page);
    const steps = [];
    steps.push(await interaction(
      page,
      'enter-smoke',
      ['selectValue', '#render-mode', 'smoke'],
      ['smokeReady'],
      { settle: false, timeoutMs: 120_000 }
    ));
    steps.push(await idleWindow(page, 'smoke-animating', options.idleMs));
    steps.push(await orbitWindow(page, 'smoke-orbit', options.orbitFrames));
    await setRange(page, '#smoke-speed', 0);
    await settle(page);
    steps.push(await idleWindow(page, 'smoke-still', options.idleMs));
    steps.push(await interaction(
      page,
      'smoke-grid-rebuild',
      ['toggleRange', '#smoke-grid', 30, 80],
      ['passEntered', 'smoke-build'],
      { timeoutMs: 120_000 }
    ));
    steps.push(await interaction(
      page,
      'exit-smoke',
      ['selectValue', '#render-mode', 'points'],
      null,
      { timeoutMs: 60_000 }
    ));
    return { views: 1, steps };
  },

  async velocity(page, options) {
    const enabled = await page.evaluate(() => {
      const box = document.getElementById('velocity-overlay-enabled');
      return box instanceof HTMLInputElement && !box.disabled;
    });
    if (!enabled) {
      return { skipped: 'The velocity overlay is not available for this dataset (no vector field).' };
    }
    const views = await ensureViews(page, options.views);
    await settle(page);
    const steps = [];
    steps.push(await interaction(
      page,
      'enable-velocity',
      ['click', '#velocity-overlay-enabled'],
      ['passEntered', 'velocity-particles'],
      { settle: false, timeoutMs: 120_000 }
    ));
    steps.push(await idleWindow(page, 'velocity-animating', options.idleMs));
    steps.push(await orbitWindow(page, 'velocity-orbit', options.orbitFrames));
    steps.push(await interaction(
      page,
      'disable-velocity',
      ['click', '#velocity-overlay-enabled'],
      null,
      { timeoutMs: 60_000 }
    ));
    steps.push(await idleWindow(page, 'after-velocity', options.idleMs));
    return { views, steps };
  },

  async edges(page, options) {
    const available = await page.evaluate(() => {
      const box = document.getElementById('toggle-connectivity');
      return box instanceof HTMLInputElement && !box.disabled;
    });
    if (!available) {
      return { skipped: 'Connectivity is not available for this dataset.' };
    }
    const field = await colourByFirstCategory(page);
    const views = await ensureViews(page, options.views);
    await settle(page);
    const steps = [];
    steps.push(await interaction(
      page,
      'enable-edges',
      ['check', '#toggle-connectivity'],
      ['passEntered', 'edges'],
      { timeoutMs: 120_000 }
    ));
    steps.push(await idleWindow(page, 'edges-static', options.idleMs));
    steps.push(await orbitWindow(page, 'edges-orbit', options.orbitFrames));
    steps.push(await interaction(
      page,
      'edges-limit-max',
      ['setRange', '#connectivity-limit', 'max'],
      null,
      { frameTimeoutMs: 5_000 }
    ));
    if (field !== null) {
      steps.push(await interaction(
        page,
        'edges-filter-hide-category',
        ['click', '.legend-item .legend-checkbox'],
        null,
        { frameTimeoutMs: 5_000 }
      ));
      steps.push(await interaction(
        page,
        'edges-filter-show-category',
        ['click', '.legend-item .legend-checkbox'],
        null,
        { frameTimeoutMs: 5_000 }
      ));
    }
    steps.push(await orbitWindow(page, 'edges-orbit-max', options.orbitFrames));
    return { views, field, steps };
  },

  async selection(page, options) {
    const field = await colourByFirstCategory(page, 'cell_type');
    const views = await ensureViews(page, options.views);
    await page.locator('.highlight-mode-btn[data-mode="lasso"]').click();
    await settle(page);
    const box = await page.locator('#glcanvas').boundingBox();
    // The sidebar covers the left of the canvas; draw in the right part.
    const centreX = box.x + box.width * 0.62;
    const centreY = box.y + box.height * 0.5;
    const radiusX = box.width * 0.22;
    const radiusY = box.height * 0.3;
    const moves = 60;
    const steps = [];
    let armed = false;
    for (let attempt = 0; attempt < 4 && !armed; attempt++) {
      const record = await measured(page, attempt === 0 ? 'lasso-drag' : `lasso-drag-retry-${attempt}`, async () => {
        await page.mouse.move(centreX + radiusX, centreY);
        await page.keyboard.down('Alt');
        await page.mouse.down();
        for (let index = 1; index <= moves; index++) {
          const angle = (index / moves) * Math.PI * 2;
          await page.mouse.move(centreX + Math.cos(angle) * radiusX, centreY + Math.sin(angle) * radiusY);
        }
        await page.mouse.up();
        await page.keyboard.up('Alt');
        // A pulsing highlight (the default Full quality) never lets the scene
        // settle, so the window ends a fixed grace period after release.
        await page.waitForTimeout(500);
      }, { settle: false });
      record.pointerMoves = moves;
      steps.push(record);
      armed = await page.locator('#lasso-step-controls').count() > 0;
    }
    const selectedBeforeConfirm = await page.evaluate(() => window._cellucidViewer.getHighlightedCount?.() ?? null);
    if (armed && await page.locator('#lasso-confirm-btn').isEnabled()) {
      steps.push(await measured(page, 'lasso-confirm', async () => {
        await page.locator('#lasso-confirm-btn').click();
        await page.waitForTimeout(500);
      }, { settle: false }));
    }
    const highlighted = await page.evaluate(() => window._cellucidViewer.getHighlightedCount?.() ?? null);
    steps.push(await idleWindow(page, 'highlight-idle', options.idleMs));
    steps.push(await orbitWindow(page, 'highlight-orbit', options.orbitFrames));
    return { views, field, armed, selectedBeforeConfirm, highlighted, steps };
  },

  async session(page, options, context) {
    await colourByFirstCategory(page, 'cell_type');
    const views = await ensureViews(page, Math.max(2, options.views));
    await settle(page);
    const steps = [];
    let sessionPath = null;
    steps.push(await measured(page, 'session-save', async () => {
      const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });
      await page.locator('#save-state-btn').click();
      const download = await downloadPromise;
      sessionPath = path.join(context.outDir, `${context.stamp}-session.cellucid-session`);
      await download.saveAs(sessionPath);
    }));
    // Restore into the same page: the restore replaces every view.
    await page.evaluate(() => {
      const scenario = window.__renderScenario;
      scenario.calls = [
        scenario.probes.countCalls(window._cellucidState, [
          'computeGlobalVisibility',
          'setActiveView',
          'restoreContext',
          'captureCurrentContext'
        ]),
        scenario.probes.countCalls(window._cellucidViewer, [
          'updateColors',
          'updateTransparency',
          'updatePositions',
          'createSnapshotView',
          'updateSnapshotAttributes',
          'clearSnapshotViews',
          'setViewEmbedding'
        ])
      ];
    });
    const restore = await measured(page, 'session-restore', async () => {
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 60_000 });
      await page.locator('#load-state-btn').click();
      const chooser = await chooserPromise;
      await chooser.setFiles(sessionPath);
      await waitFor(
        page,
        expected => window._cellucidViewer.getSnapshotViews().length + 1 === expected,
        views,
        120_000,
        'the restored views'
      );
      await page.waitForTimeout(500);
    }, { settleTimeoutMs: 120_000 });
    restore.calls = await page.evaluate(() => {
      const scenario = window.__renderScenario;
      const counts = {};
      for (const handle of scenario.calls) {
        Object.assign(counts, handle.counts);
        handle.restore();
      }
      return counts;
    });
    steps.push(restore);
    return { views, sessionBytes: statSync(sessionPath).size, steps };
  },

  async export(page, options) {
    const views = await ensureViews(page, options.views);
    await page.locator('#figure-export-section > summary').click();
    await page.getByRole('button', { name: /^Download\b/ }).click();
    await settle(page);
    const steps = [];
    const jobs = [
      { format: 'svg', strategy: 'full-vector' },
      { format: 'svg', strategy: 'optimized-vector' },
      { format: 'png', strategy: null }
    ];
    for (const { format, strategy } of jobs) {
      await page.getByLabel('Download format').selectOption(format);
      if (strategy !== null) await page.getByLabel('SVG point strategy').selectOption(strategy);
      await page.evaluate(() => {
        const scenario = window.__renderScenario;
        scenario.contexts = scenario.probes.countContextRequests();
      });
      let bytes = null;
      let blockedBy = null;
      const label = strategy === null ? `export-${format}` : `export-${format}-${strategy}`;
      const record = await measured(page, label, async () => {
        const downloadPromise = page.waitForEvent('download', { timeout: 300_000 });
        await page.locator('#figure-export-btn').click();
        // The export refuses a figure it cannot draw faithfully with a dialog
        // that only offers Back; report that instead of waiting for a download.
        const warning = page.locator('.figure-export-warning').first();
        const invalid = page.locator('#figure-export-section :invalid').first();
        const outcome = await Promise.race([
          downloadPromise.then(download => ({ download })),
          warning.waitFor({ state: 'visible', timeout: 300_000 }).then(() => ({ warning: true })),
          invalid.waitFor({ state: 'attached', timeout: 300_000 }).then(() => ({ invalid: true })),
          page.getByText(/^Export failed:/).first()
            .waitFor({ state: 'visible', timeout: 300_000 })
            .then(() => ({ failed: true }))
        ]);
        if (outcome.failed) {
          downloadPromise.catch(() => {});
          const message = await page.getByText(/^Export failed:/).first().innerText();
          throw new Error(`The application reported: ${message.trim()}`);
        }
        if (outcome.invalid) {
          downloadPromise.catch(() => {});
          const message = await invalid.evaluate(node =>
            `${node.getAttribute('aria-label') ?? node.id}: ${node.validationMessage}`);
          throw new Error(`The export form refused its input (${message}).`);
        }
        if (outcome.warning) {
          blockedBy = await page.locator('.figure-export-warning').allInnerTexts();
          await page.getByRole('button', { name: 'Back' }).click();
          downloadPromise.catch(() => {});
          return;
        }
        const target = await outcome.download.path();
        bytes = target ? statSync(target).size : null;
      }, { settleTimeoutMs: 120_000 });
      record.blockedBy = blockedBy;
      record.strategy = strategy;
      record.contextRequests = await page.evaluate(() => {
        const scenario = window.__renderScenario;
        const counts = { ...scenario.contexts.counts };
        scenario.contexts.restore();
        return counts;
      });
      record.outputBytes = bytes;
      steps.push(record);
    }
    return { views, steps };
  }
};

// ------------------------------------------------------------------ main

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.list) {
    for (const scenario of SCENARIO_ORDER) {
      console.log(`${scenario.padEnd(10)} default source: ${DEFAULT_SOURCES[scenario]}`);
    }
    return;
  }
  if (!options.force) assertQuietMachine();

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = options.out ??
    path.join(REPOSITORY_ROOT, 'test-results', 'render-scenarios', `${options.engine}-${stamp}.json`);
  const outDir = path.dirname(out);
  mkdirSync(outDir, { recursive: true });

  let commit = null;
  try {
    commit = execSync('git rev-parse HEAD', { cwd: REPOSITORY_ROOT, encoding: 'utf8' }).trim();
  } catch {
    commit = null;
  }

  const server = await startServer(options.port, options.dataRoot);
  const origin = `http://127.0.0.1:${options.port}`;
  const browser = await launchBrowser(options.engine, options.headed);
  const report = {
    tool: 'scripts/render-scenarios.mjs',
    startedAt: new Date().toISOString(),
    commit,
    engine: options.engine,
    browserVersion: browser.version(),
    options: { ...options, out },
    scenarios: {}
  };
  const save = () => writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

  try {
    for (const name of options.scenarios) {
      const source = options.source ?? DEFAULT_SOURCES[name];
      const started = Date.now();
      console.log(`[render-scenarios] ${name} on ${source} (${options.engine})`);
      const context = await browser.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: options.dpr,
        acceptDownloads: true
      });
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      const entry = { source, pageErrors };
      try {
        await loadSource(page, origin, source, options);
        await page.evaluate(({ culling, antialias, quality }) => {
          const viewer = window._cellucidViewer;
          viewer.setAdaptiveLOD(culling === 'lod+frustum' || culling === 'lod');
          viewer.setFrustumCulling(culling === 'lod+frustum' || culling === 'frustum');
          if (antialias !== undefined) viewer.setAntialiasing(antialias === 'on');
          if (quality !== undefined) {
            // Through the control, so the app's own state follows.
            const select = document.getElementById('hp-shader-quality');
            select.value = quality;
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, { culling: options.culling, antialias: options.antialias, quality: options.quality });
        entry.culling = options.culling;
        entry.antialiasing = await page.evaluate(() => window._cellucidViewer.getAntialiasing());
        const timing = options.timing ?? options.engine === 'chromium';
        entry.environment = await installProbes(page, timing);
        Object.assign(entry, await SCENARIOS[name](page, options, { outDir, stamp }));
      } catch (error) {
        entry.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
        console.error(`[render-scenarios] ${name} failed: ${entry.error.split('\n')[0]}`);
      } finally {
        entry.elapsedMs = Date.now() - started;
        report.scenarios[name] = entry;
        save();
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
  report.finishedAt = new Date().toISOString();
  save();
  console.log(`[render-scenarios] wrote ${out}`);
  const failed = Object.entries(report.scenarios).filter(([, entry]) => entry.error);
  if (failed.length > 0) {
    console.error(`[render-scenarios] ${failed.length} scenario(s) failed: ${failed.map(([name]) => name).join(', ')}`);
    process.exitCode = 1;
  }
}

await main();
