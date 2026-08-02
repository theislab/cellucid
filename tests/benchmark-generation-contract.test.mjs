import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertGenerationRequest,
  assertGenerationResponse,
  assertSyntheticCount,
  assertSyntheticPattern,
  FETCHED_PATTERNS,
  MAX_SYNTHETIC_COUNT,
  MIN_SYNTHETIC_COUNT,
  SYNTHETIC_PATTERNS
} from '../assets/js/app/ui/modules/benchmark/generation-contract.js';

function validResponse(count, overrides = {}) {
  return {
    requestId: 0,
    ok: true,
    positions: new Float32Array(count * 3),
    colors: new Uint8Array(count * 4),
    dimensionLevel: 3,
    elapsedMs: 12.5,
    ...overrides
  };
}

test('the worker covers every pattern the benchmark UI offers', async () => {
  const indexHtml = await readFile(
    new URL('../index.html', import.meta.url),
    'utf8'
  );
  const select = indexHtml.slice(
    indexHtml.indexOf('<select id="benchmark-pattern"'),
    indexHtml.indexOf('</select>', indexHtml.indexOf('<select id="benchmark-pattern"'))
  );
  const offered = [...select.matchAll(/value="([^"]+)"/g)].map(match => match[1]);
  assert.ok(offered.length > 0, 'the benchmark pattern select must offer values');
  for (const pattern of offered) {
    assert.ok(
      SYNTHETIC_PATTERNS.includes(pattern),
      `pattern "${pattern}" is offered by the UI but not generatable off-thread`
    );
  }
});

test('a fetched pattern must carry an absolute URL across the boundary', () => {
  // A worker resolves a relative URL against its own script, not the page, so
  // a document-relative URL would silently fetch the wrong path.
  for (const pattern of FETCHED_PATTERNS) {
    assert.throws(
      () => assertGenerationRequest({ requestId: 0, pattern, count: 10 }),
      /requires one absolute sourceUrl/
    );
    const request = assertGenerationRequest({
      requestId: 0,
      pattern,
      count: 10,
      sourceUrl: 'http://127.0.0.1:4173/assets/img/kemal-inecik.glb'
    });
    assert.equal(
      request.sourceUrl,
      'http://127.0.0.1:4173/assets/img/kemal-inecik.glb'
    );
  }
});

test('a computed pattern refuses a source URL it would ignore', () => {
  assert.throws(
    () =>
      assertGenerationRequest({
        requestId: 0,
        pattern: 'atlas',
        count: 10,
        sourceUrl: 'http://127.0.0.1:4173/anything'
      }),
    /is computed and takes no sourceUrl/
  );
});

test('a request is refused before a worker is spawned for it', () => {
  assert.throws(() => assertGenerationRequest(null), /plain object/);
  assert.throws(
    () => assertGenerationRequest({ requestId: -1, pattern: 'atlas', count: 1 }),
    /non-negative safe integer/
  );
  assert.throws(
    () => assertGenerationRequest({ requestId: 0, pattern: 'nope', count: 1 }),
    /Synthetic pattern must be one of/
  );
  assert.throws(
    () => assertGenerationRequest({ requestId: 0, pattern: 'atlas', count: 0 }),
    /must be one integer between 1 and 50000000/
  );
  assert.throws(() => assertSyntheticPattern('spiral'), /Synthetic pattern/);
  assert.throws(
    () => assertSyntheticCount(1.5),
    /must be one integer between 1 and 50000000/
  );
});

test('the point-count control and both validators enforce one rule', async () => {
  // The control used to advertise 1,000–50,000,000 while both validators
  // accepted 1 and had no ceiling at all, so a programmatic request reached
  // multiples of the range the UI published. index.html is static markup and
  // cannot interpolate a constant, so the derivation is asserted here.
  assert.equal(MIN_SYNTHETIC_COUNT, 1);
  assert.equal(MAX_SYNTHETIC_COUNT, 50_000_000);
  assert.equal(assertSyntheticCount(MIN_SYNTHETIC_COUNT), MIN_SYNTHETIC_COUNT);
  assert.equal(assertSyntheticCount(MAX_SYNTHETIC_COUNT), MAX_SYNTHETIC_COUNT);
  assert.throws(
    () => assertSyntheticCount(MIN_SYNTHETIC_COUNT - 1),
    /must be one integer between/
  );
  assert.throws(
    () => assertSyntheticCount(MAX_SYNTHETIC_COUNT + 1),
    /must be one integer between/
  );
  assert.throws(
    () =>
      assertGenerationRequest({
        requestId: 0,
        pattern: 'atlas',
        count: MAX_SYNTHETIC_COUNT + 1
      }),
    /must be one integer between/
  );

  const indexHtml = await readFile(
    new URL('../index.html', import.meta.url),
    'utf8'
  );
  const control = indexHtml.slice(
    indexHtml.indexOf('<input type="number" id="benchmark-count"'),
    indexHtml.indexOf(
      '/>',
      indexHtml.indexOf('<input type="number" id="benchmark-count"')
    )
  );
  assert.ok(control.length > 0, 'the point-count control must exist');
  assert.match(control, new RegExp(`\\bmin="${MIN_SYNTHETIC_COUNT}"`));
  assert.match(control, new RegExp(`\\bmax="${MAX_SYNTHETIC_COUNT}"`));
  // A step whose grid excludes the control's own value and every preset makes
  // the field permanently step-invalid; the count is an exact integer.
  assert.match(control, /\bstep="1"/);

  const defaultValue = Number(/\bvalue="(\d+)"/.exec(control)[1]);
  assert.equal(assertSyntheticCount(defaultValue), defaultValue);

  const presets = [
    ...indexHtml.matchAll(/class="btn-small benchmark-preset" data-count="(\d+)"/g)
  ].map(match => Number(match[1]));
  assert.ok(presets.length > 0, 'the benchmark presets must publish counts');
  for (const preset of presets) {
    assert.equal(
      assertSyntheticCount(preset),
      preset,
      `preset ${preset} is offered but outside the declared range`
    );
  }
});

test('every generator entry point is held to the same rule', async () => {
  const { SyntheticDataGenerator } = await import(
    '../assets/js/dev/benchmark.js'
  );
  // Only the two GLB entry points validated their count; the rest allocated
  // from whatever arrived, so a zero produced empty arrays and a negative
  // failed inside a typed-array constructor instead of at the boundary.
  const entryPoints = [
    'atlasLike',
    'batchEffects',
    'flatUMAP',
    'gaussianClusters',
    'octopus',
    'spirals',
    'uniformRandom'
  ];
  for (const name of entryPoints) {
    for (const invalid of [0, -1, 1.5, MAX_SYNTHETIC_COUNT + 1]) {
      assert.throws(
        () => SyntheticDataGenerator[name](invalid),
        /must be one integer between 1 and 50000000/,
        `${name}(${invalid}) must be refused at the boundary`
      );
    }
  }
  await assert.rejects(
    SyntheticDataGenerator.fromGLBUrl(MAX_SYNTHETIC_COUNT + 1),
    /must be one integer between 1 and 50000000/
  );
  assert.throws(
    () => SyntheticDataGenerator.fromGLB(0, new ArrayBuffer(8)),
    /must be one integer between 1 and 50000000/
  );
});

test('a response is checked against the exact lengths publication demands', () => {
  // The viewer's synthetic publication path requires 3N floats and 4N bytes.
  // Checking here means a length mismatch is reported against generation
  // rather than surfacing later as a renderer failure.
  const count = 1000;
  assert.equal(
    assertGenerationResponse(validResponse(count), count).dimensionLevel,
    3
  );
  assert.throws(
    () =>
      assertGenerationResponse(
        validResponse(count, { positions: new Float32Array(count * 2) }),
        count
      ),
    /3000 Float32 position components/
  );
  assert.throws(
    () =>
      assertGenerationResponse(
        validResponse(count, { colors: new Uint8Array(count * 3) }),
        count
      ),
    /4000 Uint8 colour components/
  );
  assert.throws(
    () =>
      assertGenerationResponse(validResponse(count, { dimensionLevel: 4 }), count),
    /exactly 1, 2, or 3/
  );
  assert.throws(
    () => assertGenerationResponse(validResponse(count, { ok: false }), count),
    /ok === true/
  );
  assert.throws(
    () =>
      assertGenerationResponse(
        validResponse(count, { elapsedMs: Number.NaN }),
        count
      ),
    /finite non-negative elapsedMs/
  );
  assert.throws(
    () => assertGenerationResponse(null, count),
    /plain object/
  );
});

test('the two-dimensional pattern keeps its own dimension level', () => {
  const response = validResponse(4, { dimensionLevel: 2 });
  assert.equal(assertGenerationResponse(response, 4).dimensionLevel, 2);
});

test('the worker module imports only what a worker thread can evaluate', async () => {
  const workerSource = await readFile(
    new URL(
      '../assets/js/app/ui/modules/benchmark/generation-worker.js',
      import.meta.url
    ),
    'utf8'
  );
  // A worker has no document and no window. Importing the generators is
  // deliberate; reaching for the DOM from the worker would not survive.
  assert.doesNotMatch(workerSource, /\bdocument\./);
  assert.doesNotMatch(workerSource, /\bwindow\./);
  assert.match(
    workerSource,
    /import \{ SyntheticDataGenerator \} from '\.\.\/\.\.\/\.\.\/\.\.\/dev\/benchmark\.js'/
  );
  for (const pattern of SYNTHETIC_PATTERNS) {
    assert.match(
      workerSource,
      new RegExp(`\\b${pattern}:`),
      `the worker must be able to generate "${pattern}"`
    );
  }
});
