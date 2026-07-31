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
  const ensure = functionBody(mainSource, 'function ensureBenchmarkModule(');
  assert.ok(
    ensure.includes(`import('${HARNESS_SPECIFIER}')`),
    'ensureBenchmarkModule must import the harness module'
  );
  assert.ok(
    ensure.includes(`${HARNESS_GLOBAL} =`),
    `ensureBenchmarkModule must publish ${HARNESS_GLOBAL}`
  );

  // The publication has to happen before the module is marked loaded, or a
  // second caller can observe `benchmarkModuleLoaded` while the global is
  // still absent.
  assert.ok(
    ensure.indexOf(HARNESS_GLOBAL) <
      ensure.indexOf('benchmarkModuleLoaded = true'),
    'the harness must be published before the load flag is set'
  );

  // The Performance Benchmark panel is what triggers the lazy load, so the
  // entry point is only reachable while that panel exists.
  assert.match(indexHtml, /\bid="benchmark-section"/);
  const panelToggle = functionBody(
    mainSource,
    "benchmarkSection.addEventListener('toggle'"
  );
  assert.ok(panelToggle.includes('await ensureBenchmarkModule()'));
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
