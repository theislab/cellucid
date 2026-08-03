/**
 * The configuration-matrix harness under `assets/js/app/ui/modules/benchmark/`
 * is the only thing in the tree that can sweep LOD, frustum culling and view
 * count while counting per-frame GPU uploads. It had no entry point in the
 * running application at all (CEL-AUDIT-0094): nothing imported it, and the
 * page is served under `script-src 'self'` with one hashed inline block, so it
 * could not be bootstrapped from the page either.
 *
 * This test pins the wiring to the module's real surface, so the entry point
 * cannot survive as a name that resolves to nothing.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as harness from '../assets/js/app/ui/modules/benchmark/index.js';
import {
  PerformanceTracker as LivePerformanceTracker,
} from '../assets/js/app/ui/modules/benchmark/performance-tracker.js';
import {
  PerformanceTracker as PublicPerformanceTracker,
} from '../assets/js/dev/benchmark.js';

const MAIN_URL = new URL('../assets/js/app/main.js', import.meta.url);
const INDEX_URL = new URL('../index.html', import.meta.url);
const HARNESS_SPECIFIER = './ui/modules/benchmark/index.js';
const HARNESS_GLOBAL = 'window._cellucidBenchmarkHarness';

const [mainSource, indexHtml] = await Promise.all([
  readFile(MAIN_URL, 'utf8'),
  readFile(INDEX_URL, 'utf8')
]);

function functionBody(source, declaration) {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} must exist in main.js`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`${declaration} is unbalanced`);
}

test('opening the benchmark panel publishes the harness module', () => {
  const ensureHarness = functionBody(
    mainSource,
    'function ensureBenchmarkHarnessModule('
  );
  const ensureLiveRuntime = functionBody(
    mainSource,
    'function ensureBenchmarkModule('
  );
  const ensureSupport = functionBody(
    mainSource,
    'function ensureBenchmarkSupportModule('
  );
  assert.ok(
    ensureHarness.includes(`import('${HARNESS_SPECIFIER}')`),
    'ensureBenchmarkHarnessModule must import the harness module'
  );
  assert.match(
    ensureLiveRuntime,
    /Promise\.all\(\[[\s\S]*?import\('\.\/ui\/modules\/benchmark\/generation\.js'\)[\s\S]*?import\('\.\/ui\/modules\/benchmark\/generation-contract\.js'\)[\s\S]*?import\('\.\/ui\/modules\/benchmark\/performance-tracker\.js'\)/,
    'live readiness must request only generation and tracker graphs'
  );
  assert.ok(
    ensureLiveRuntime.indexOf('benchmarkModuleLoaded = true') <
      ensureLiveRuntime.lastIndexOf('void ensureBenchmarkHarnessModule()'),
    'the full harness must start only after live panel readiness is published'
  );
  assert.match(
    ensureLiveRuntime,
    /if \(benchmarkModuleLoaded\) \{[\s\S]*?void ensureBenchmarkHarnessModule\(\);[\s\S]*?return Promise\.resolve\(true\);/,
    'a later panel activation must retry an independently failed harness load'
  );
  assert.doesNotMatch(
    ensureLiveRuntime,
    /dev\/benchmark\.js|ensureBenchmarkSupportModule/,
    'live panel readiness must not wait for optional report or analyzer support'
  );
  assert.ok(
    ensureSupport.includes("import('../dev/benchmark.js')"),
    'the developer-support graph must retain its own explicit lazy owner'
  );
  assert.ok(
    ensureHarness.includes(`${HARNESS_GLOBAL} =`),
    `ensureBenchmarkHarnessModule must publish ${HARNESS_GLOBAL}`
  );

  // Publication is the harness owner's atomic readiness boundary. It must not
  // be hidden behind tracker construction or the optional support graph.
  assert.ok(
    ensureHarness.indexOf(HARNESS_GLOBAL) <
      ensureHarness.indexOf('benchmarkHarnessModule = harnessModule'),
    'the harness global must be published before the owner caches readiness'
  );

  // The Performance Benchmark panel is what triggers the lazy load, so the
  // entry point is only reachable while that panel exists.
  assert.match(indexHtml, /\bid="benchmark-section"/);
  const panelSynchronization = functionBody(
    mainSource,
    'const synchronizeBenchmarkPanelWithSection = async ()'
  );
  assert.ok(panelSynchronization.includes('await ensureBenchmarkModule()'));
  assert.match(
    mainSource,
    /benchmarkSection\.addEventListener\(\s*'toggle',\s*ownBenchmarkPanelSynchronization\s*\)/,
    'the panel toggle must route through the synchronization owner'
  );

  // A summary click is the synchronous user activation. Firefox can defer the
  // later `toggle` task behind stressed native rendering, so the click path
  // must start the module request and reconcile the final open state itself.
  const summaryActivation = functionBody(
    mainSource,
    'const ownBenchmarkSummaryActivation = ()'
  );
  assert.ok(summaryActivation.includes('ensureBenchmarkModule()'));
  assert.ok(summaryActivation.includes('publishBenchmarkPanelState()'));
  assert.match(
    mainSource,
    /benchmarkSummary\.addEventListener\(\s*'click',\s*ownBenchmarkSummaryActivation\s*\)/,
    'the direct summary activation must own a lazy-load signal'
  );

  assert.match(
    ensureLiveRuntime,
    /if \(!loaded && benchmarkModuleLoadTask === loadTask\) \{\s*benchmarkModuleLoadTask = null;/,
    'a failed lazy load must be retryable from the next activation'
  );
});

test('the live tracker is the stable public PerformanceTracker', () => {
  assert.strictEqual(PublicPerformanceTracker, LivePerformanceTracker);
  const tracker = new LivePerformanceTracker({ warmupFrames: 0 });
  assert.equal(typeof tracker.recordFrame, 'function');
  assert.equal(typeof tracker.pause, 'function');
  assert.equal(typeof tracker.resume, 'function');
});

test('the published module is the one the harness is created from', () => {
  assert.equal(typeof harness.createBenchmarkHarness, 'function');
  // `createBenchmarkHarness({ viewer, canvas })` is the documented call; the
  // canvas argument is mandatory, which is what binds the harness to the live
  // context rather than to a detached one.
  assert.throws(
    () => harness.createBenchmarkHarness({ viewer: {}, canvas: null }),
    /requires the viewer canvas/
  );
  assert.throws(
    () => harness.createBenchmarkHarness(null),
    /must be one plain object/
  );

  for (const name of [
    'createBenchmarkMatrixRunner',
    'expandMatrix',
    'instrumentGlUploads',
    'readRendererIdentity',
    'FrameRecorder',
    'BenchmarkCameraPath'
  ]) {
    assert.equal(
      typeof harness[name],
      'function',
      `the harness entry point must re-export ${name}`
    );
  }
});

test('the harness does nothing until it is created', () => {
  // Importing the module must not touch the page: the counters shadow live
  // WebGL methods, so an import-time install would put wrappers on the
  // product's render path for every user who opens the panel.
  assert.doesNotMatch(
    mainSource,
    new RegExp(`${HARNESS_GLOBAL.replace('.', '\\.')}[\\s\\S]{0,200}?createBenchmarkHarness`),
    'main.js must not construct a harness while loading the module'
  );
});
