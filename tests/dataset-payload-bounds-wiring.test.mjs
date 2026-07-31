// The loader layer accepts an exact declared payload length, but a bound is
// only real if the composition root actually supplies it. `main.js` owns every
// dataset runtime seam, so these tests take main.js's own call expressions,
// execute them against the real loaders, and prove the exact
// `n_points × dtype` length reaches the transport.
//
// A loader that is handed no length falls back to the 512 MiB browser ceiling:
// a truncated or over-long payload is then accepted at the transport and only
// misbehaves later, far away from the fetch that caused it.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  createObsFieldLoader,
  createVarFieldLoader,
  expandObsManifest,
  expandVarManifest,
} from '../assets/js/data/data-loaders.js';
import { createDimensionManager } from '../assets/js/data/dimension-manager.js';

const mainSource = readFileSync(
  new URL('../assets/js/app/main.js', import.meta.url),
  'utf8'
);

const N_POINTS = 7;
const FLOAT32_BYTES = 4;
const BASE_URL = 'https://catalog.cellucid.test/exports/demo/';
const FAST_BINARY_FETCH_INIT = { cache: 'force-cache' };

/**
 * The exact `name(...)` call expression main.js writes, extracted by balanced
 * parentheses so the test executes main.js's real arguments rather than a
 * paraphrase of them.
 *
 * @param {string} functionName
 * @returns {string}
 */
function extractCallExpression(functionName) {
  const needle = `${functionName}(`;
  const start = mainSource.indexOf(needle);
  assert.ok(start >= 0, `main.js must call ${functionName}()`);
  let depth = 0;
  for (let index = start + needle.length - 1; index < mainSource.length; index++) {
    const character = mainSource[index];
    if (character === '(') depth++;
    else if (character === ')') {
      depth--;
      if (depth === 0) return mainSource.slice(start, index + 1);
    }
  }
  assert.fail(`main.js has an unbalanced ${functionName}() call`);
}

function extractStatements(startNeedle, endNeedle) {
  const start = mainSource.indexOf(startNeedle);
  assert.ok(start >= 0, `main.js must contain ${startNeedle}`);
  const end = mainSource.indexOf(endNeedle, start);
  assert.ok(end > start, `main.js must contain ${endNeedle} after ${startNeedle}`);
  return mainSource.slice(start + startNeedle.length, end);
}

function installFetch(t, handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  });
}

function obsManifest() {
  return expandObsManifest({
    _format: 'compact_v1',
    n_points: N_POINTS,
    centroid_outlier_quantile: null,
    latent_key: null,
    compression: null,
    _obsSchemas: {
      continuous: {
        pathPattern: 'obs/{index}.values.f32',
        ext: 'f32',
        dtype: 'float32',
        quantized: false,
      },
    },
    _continuousFields: [[0, 'score']],
    _categoricalFields: [],
  });
}

function varManifest() {
  return expandVarManifest({
    _format: 'compact_v1',
    n_points: N_POINTS,
    var_gene_id_column: null,
    compression: null,
    quantization: null,
    _varSchema: {
      kind: 'continuous',
      pathPattern: 'var/{index}.values.f32',
      ext: 'f32',
      dtype: 'float32',
      quantized: false,
    },
    fields: [[0, 'Gene A']],
  });
}

function embeddingsMetadata() {
  return {
    available_dimensions: [2],
    default_dimension: 2,
    files: { '2d': 'points_2d.bin' },
  };
}

function datasetIdentity() {
  return {
    stats: { n_cells: N_POINTS },
    embeddings: embeddingsMetadata(),
  };
}

// ---------------------------------------------------------------------------
// Observation and gene expression field payloads
// ---------------------------------------------------------------------------

test('main.js gives the obs field loader the manifest-declared point count', async t => {
  const generation = { obsManifest: obsManifest() };
  const buildLoader = new Function(
    'createObsFieldLoader',
    'getObsManifestUrl',
    'baseUrl',
    'FAST_BINARY_FETCH_INIT',
    'generation',
    `return ${extractCallExpression('createObsFieldLoader')};`
  );
  const loader = buildLoader(
    createObsFieldLoader,
    base => `${base}obs_manifest.json`,
    BASE_URL,
    FAST_BINARY_FETCH_INIT,
    generation
  );

  const requestedUrls = [];
  // One float32 too many. Under the 512 MiB ceiling this is accepted and the
  // extra observation is silently carried into the scene.
  installFetch(t, async url => {
    requestedUrls.push(url);
    return new Response(new Uint8Array((N_POINTS + 1) * FLOAT32_BYTES), {
      status: 200,
    });
  });

  await assert.rejects(
    loader(generation.obsManifest.fields[0]),
    new RegExp(
      `transfer of at least ${(N_POINTS + 1) * FLOAT32_BYTES} bytes ` +
      `exceeds its ${N_POINTS * FLOAT32_BYTES}-byte ceiling`
    ),
    'the obs payload must be judged against n_points × float32, not the ceiling'
  );
  assert.deepEqual(requestedUrls, [`${BASE_URL}obs/0.values.f32`]);
});

test('main.js gives the var field loader the manifest-declared point count', async t => {
  const generation = { varManifest: varManifest() };
  const buildLoader = new Function(
    'createVarFieldLoader',
    'getVarManifestUrl',
    'baseUrl',
    'FAST_BINARY_FETCH_INIT',
    'generation',
    `return ${extractCallExpression('createVarFieldLoader')};`
  );
  const loader = buildLoader(
    createVarFieldLoader,
    base => `${base}var_manifest.json`,
    BASE_URL,
    FAST_BINARY_FETCH_INIT,
    generation
  );

  const requestedUrls = [];
  // One float32 short: a truncated gene expression column.
  installFetch(t, async url => {
    requestedUrls.push(url);
    return new Response(new Uint8Array((N_POINTS - 1) * FLOAT32_BYTES), {
      status: 200,
    });
  });

  await assert.rejects(
    loader(generation.varManifest.fields[0]),
    new RegExp(
      `expected exactly ${N_POINTS * FLOAT32_BYTES} bytes, ` +
      `received ${(N_POINTS - 1) * FLOAT32_BYTES}`
    ),
    'the var payload must be judged against n_points × float32, not the ceiling'
  );
  assert.deepEqual(requestedUrls, [`${BASE_URL}var/0.values.f32`]);
});

test('an exactly declared obs payload still loads', async t => {
  const generation = { obsManifest: obsManifest() };
  const buildLoader = new Function(
    'createObsFieldLoader',
    'getObsManifestUrl',
    'baseUrl',
    'FAST_BINARY_FETCH_INIT',
    'generation',
    `return ${extractCallExpression('createObsFieldLoader')};`
  );
  const loader = buildLoader(
    createObsFieldLoader,
    base => `${base}obs_manifest.json`,
    BASE_URL,
    FAST_BINARY_FETCH_INIT,
    generation
  );

  installFetch(t, async () => new Response(
    new Uint8Array(N_POINTS * FLOAT32_BYTES),
    { status: 200 }
  ));

  const loaded = await loader(generation.obsManifest.fields[0]);
  assert.equal(loaded.loaded, true);
  assert.equal(loaded.values.length, N_POINTS);
});

// ---------------------------------------------------------------------------
// The first embedding of a dataset
// ---------------------------------------------------------------------------

test('main.js publishes the identity cell axis before the first dimension loads', async t => {
  // initFromMetadata clears the cache, and a cache clear resets nCells to 0, so
  // the count can only be published after it. Anything published at
  // construction is discarded and the first embedding is ceiling-bounded.
  const publishCellAxis = new Function(
    'candidateDimensionManager',
    'embeddingsMetadata',
    'generation',
    `candidateDimensionManager.initFromMetadata(embeddingsMetadata);${
      extractStatements(
        'candidateDimensionManager.initFromMetadata(embeddingsMetadata);',
        'const positionStage = await stageDatasetPositionPayload('
      )
    }`
  );

  const dimensionManager = createDimensionManager({ baseUrl: BASE_URL });
  publishCellAxis(dimensionManager, embeddingsMetadata(), {
    identity: datasetIdentity(),
  });
  assert.equal(
    dimensionManager.getCellCount(),
    N_POINTS,
    'the manager must know the dataset cell axis before it fetches anything'
  );

  const requestedUrls = [];
  // One 2D coordinate pair too many.
  installFetch(t, async url => {
    requestedUrls.push(url);
    return new Response(
      new Uint8Array((N_POINTS + 1) * 2 * FLOAT32_BYTES),
      { status: 200 }
    );
  });

  await assert.rejects(
    dimensionManager.loadDimension(2, { showProgress: false }),
    new RegExp(
      `transfer of at least ${(N_POINTS + 1) * 2 * FLOAT32_BYTES} bytes ` +
      `exceeds its ${N_POINTS * 2 * FLOAT32_BYTES}-byte ceiling`
    ),
    'the first embedding must be bounded by n_cells × dimension × float32'
  );
  assert.deepEqual(requestedUrls, [`${BASE_URL}points_2d.bin`]);
});

test('an unpublished cell axis leaves the first embedding ceiling-bounded', async t => {
  // The state main.js used to leave the manager in. Kept as the contrast that
  // makes the fix above meaningful: without the published axis the same
  // over-long payload is accepted outright.
  const dimensionManager = createDimensionManager({ baseUrl: BASE_URL });
  dimensionManager.initFromMetadata(embeddingsMetadata());
  assert.equal(dimensionManager.getCellCount(), 0);

  installFetch(t, async () => new Response(
    new Uint8Array((N_POINTS + 1) * 2 * FLOAT32_BYTES),
    { status: 200 }
  ));

  const positions = await dimensionManager.loadDimension(2, {
    showProgress: false,
  });
  assert.equal(positions.length, (N_POINTS + 1) * 2);
});
