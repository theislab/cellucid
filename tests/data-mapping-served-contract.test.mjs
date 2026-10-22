/**
 * The served AnnData data path (`cellucid serve` of an .h5ad or .zarr, and a
 * notebook's `show_anndata()`): a mapped embedding is read from the server's
 * `_cellucid/mapping/` routes (its centroids are computed in the viewer from
 * its positions, as for a file read in the browser), and an entry
 * whose values fail the server's load-time check (HTTP 422 with
 * `{"error", "key"}`) is a refusal of that one choice -- a typed
 * `MappingLoadError` naming the key -- not a transport failure.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DimensionManager } from '../assets/js/data/dimension-manager.js';
import {
  EmbeddingLoadError,
  MappingLoadError,
  mappingRefusalFromBody,
} from '../assets/js/data/data-mapping-candidates.js';
import { createMappingLayoutProvider } from '../assets/js/app/state/managers/mapping-manager.js';

const BASE = 'http://127.0.0.1:65431/served/';

const CANDIDATES = Object.freeze({
  kind: 'anndata',
  n_obs: 3,
  obsm: [
    { key: 'X_umap', storage: 'dense', shape: [3, 2], dtype: 'float32', usable: true, reason: null },
    { key: 'X_pca', storage: 'dense', shape: [3, 4], dtype: 'float32', usable: true, reason: null },
    { key: 'X_bad', storage: 'dense', shape: [3, 2], dtype: 'float32', usable: true, reason: null },
  ],
  obsp: [],
  var: { n_vars: 0, columns: [] },
  X: null,
  layers: [],
  raw: null,
  defaults: {},
  guessed: [],
});

function servedManager() {
  const manager = new DimensionManager({
    baseUrl: BASE,
    embeddingsMetadata: {
      default_dimension: 2,
      defaults: { '2d': 'X_umap' },
      items: {
        X_umap: {
          label: 'X_umap',
          dimension: 2,
          file: 'embeddings/0_2d.bin',
          source: { key: 'X_umap', columns: [0, 1] },
        },
      },
    },
  });
  manager.setLayoutProvider(createMappingLayoutProvider(CANDIDATES));
  return manager;
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('HTTP 422 from a mapping route is a MappingLoadError naming its key', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => jsonResponse(
    {
      error: "Embedding 'X_bad' cannot be plotted: NaN at cell 1.",
      key: 'X_bad',
      reason: 'NaN at cell 1',
    },
    422
  );
  const manager = servedManager();
  const layoutKey = manager.resolveProvenanceLayout('X_bad', [0, 1]);
  await assert.rejects(
    manager.getPositions(layoutKey, { showProgress: false }),
    error => (
      error instanceof MappingLoadError &&
      error.key === 'X_bad' &&
      error.reason === 'NaN at cell 1' &&
      error.message === "Embedding 'X_bad' cannot be plotted: NaN at cell 1." &&
      error.status === 422
    )
  );
});

test('a 422 outside the mapping routes, or without a refusal body, stays a transport error', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => jsonResponse({ error: 'nope' }, 422);
  const manager = servedManager();
  const layoutKey = manager.resolveProvenanceLayout('X_pca', [0, 1]);
  await assert.rejects(
    manager.getPositions(layoutKey, { showProgress: false }),
    error => !(error instanceof MappingLoadError) && error.status === 422
  );
});

test('only an exact {"error", "key", "reason"} body is a mapping refusal', () => {
  const refusal = mappingRefusalFromBody(JSON.stringify({
    error: "obsp['d'] is not symmetric — choose a connectivities matrix.",
    key: 'd',
    reason: 'not symmetric — choose a connectivities matrix',
  }), '_cellucid/mapping/knn/0/connectivity_manifest.json');
  assert.ok(refusal instanceof MappingLoadError);
  assert.ok(!(refusal instanceof EmbeddingLoadError));
  assert.equal(refusal.key, 'd');
  assert.equal(refusal.reason, 'not symmetric — choose a connectivities matrix');
  assert.equal(refusal.message, "obsp['d'] is not symmetric — choose a connectivities matrix.");
  for (const body of [
    null,
    '',
    'not json',
    '[]',
    '{"error":"x","key":"k"}',
    '{"error":"x","key":"k","reason":"r","extra":1}',
    '{"error":"","key":"k","reason":"r"}',
    '{"error":"x","key":7,"reason":"r"}',
    '{"error":"x","key":"k","reason":""}',
  ]) {
    assert.equal(
      mappingRefusalFromBody(body, '_cellucid/mapping/knn/0/connectivity_manifest.json'),
      null,
      String(body),
    );
  }
  // An embedding refusal is a mapping refusal too.
  assert.ok(new EmbeddingLoadError('X', [0, 1], 'NaN at cell 2') instanceof MappingLoadError);
});

test('the route, not the key, says which choice a server refused', () => {
  // One obsm key is an embedding, a latent space and a vector field at once;
  // only the embedding route's refusal is an embedding's.
  const body = key => JSON.stringify({
    error: `Embedding '${key}' cannot be plotted: NaN at cell 5.`,
    key,
    reason: 'NaN at cell 5',
  });
  const embedding = mappingRefusalFromBody(body('X_broken'), '_cellucid/mapping/embeddings/3/0-1.bin');
  assert.ok(embedding instanceof EmbeddingLoadError);
  assert.deepEqual(embedding.columns, [0, 1]);
  assert.equal(embedding.message, "Embedding 'X_broken' cannot be plotted: NaN at cell 5.");
  for (const path of [
    '_cellucid/mapping/latent/3/obs/0.outliers.f32',
    '_cellucid/mapping/vectors/3/0-1/0/0-1.bin',
  ]) {
    const refusal = mappingRefusalFromBody(JSON.stringify({
      error: "Latent space 'X_broken' cannot be used: NaN at cell 5.",
      key: 'X_broken',
      reason: 'NaN at cell 5',
    }), path);
    assert.ok(refusal instanceof MappingLoadError, path);
    assert.ok(!(refusal instanceof EmbeddingLoadError), path);
  }
});
