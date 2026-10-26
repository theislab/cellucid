import assert from 'node:assert/strict';
import test from 'node:test';

import { GenesPanelController } from '../assets/js/app/analysis/genes-panel/genes-panel-controller.js';
import { MarkerCache } from '../assets/js/app/analysis/genes-panel/marker-cache.js';
import { computeCategoryGroupingDigest } from '../assets/js/app/analysis/data/data-layer.js';
import { getDataSourceManager } from '../assets/js/data/data-source-manager.js';

const PARAMS = Object.freeze({
  method: 'wilcox',
  minCells: 1,
  groupingDigest: computeCategoryGroupingDigest(Uint16Array.from([0, 1])),
});

function withManager(fields, run) {
  const manager = getDataSourceManager();
  const previous = {
    activeDatasetId: manager.activeDatasetId,
    activeDatasetMetadata: manager.activeDatasetMetadata,
    _selectionRevision: manager._selectionRevision,
  };
  Object.assign(manager, fields);
  try {
    return run(manager);
  } finally {
    Object.assign(manager, previous);
  }
}

const ANNDATA_MAPPING = Object.freeze({
  kind: 'anndata',
  embeddings: { '1d': null, '2d': { key: 'X_umap', columns: [0, 1] }, '3d': null },
  knn: null,
  geneNames: 'index',
  expression: 'X',
  log1p: {},
  highlyVariable: null,
  latent: null,
  vectorFields: [],
});

function identityFor(fields, mapping = ANNDATA_MAPPING) {
  return withManager(fields, () => {
    const controller = Object.create(GenesPanelController.prototype);
    controller.dataLayer = { state: { getDataMapping: () => mapping } };
    return controller._getCacheIdentity();
  });
}

test('a reload under the same dataset id is a new generation', () => {
  const first = identityFor({
    activeDatasetId: 'local-user:h5ad:h5ad_adata',
    activeDatasetMetadata: { id: 'h5ad_adata' },
    _selectionRevision: 4,
  });
  const reloaded = identityFor({
    activeDatasetId: 'local-user:h5ad:h5ad_adata',
    activeDatasetMetadata: { id: 'h5ad_adata' },
    _selectionRevision: 5,
  });
  assert.deepEqual(Object.keys(first), ['key']);
  assert.notEqual(first.key, reloaded.key);
});

test('markers from one generation are never served to another under the same dataset id', async () => {
  const cache = new MarkerCache({
    identity: { key: JSON.stringify(['load', 'adata', 1]) },
  });
  cache.set(PARAMS, { marker: 'GENE_ONLY_IN_V1' });
  assert.deepEqual(cache.get(PARAMS), { marker: 'GENE_ONLY_IN_V1' });

  cache.setIdentity({ key: JSON.stringify(['load', 'adata', 2]) });
  assert.equal(cache.get(PARAMS), null);
});

test('the cache lives in this page only and takes no other identity field', () => {
  assert.throws(
    () => new MarkerCache({ identity: { key: 'k', persistent: true } }),
    /exactly \{ key: non-empty string \}/
  );
  const cache = new MarkerCache({ identity: { key: 'k' } });
  assert.deepEqual(Object.keys(cache.getStats()).sort(), ['bytes', 'entries']);
});

test('another gene list under the same dataset generation is another identity', () => {
  const file = { activeDatasetId: 'adata', activeDatasetMetadata: { id: 'adata' }, _selectionRevision: 3 };
  const onX = identityFor(file);
  const onRaw = identityFor(file, { ...ANNDATA_MAPPING, expression: 'raw' });
  const bySymbol = identityFor(file, { ...ANNDATA_MAPPING, geneNames: 'column:gene_symbols' });
  assert.notEqual(onX.key, onRaw.key);
  assert.notEqual(onX.key, bySymbol.key);
  assert.equal(onX.key, identityFor(file).key);
});
