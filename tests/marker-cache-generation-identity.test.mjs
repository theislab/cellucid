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

const EXPORT_MAPPING = Object.freeze({
  kind: 'export',
  embeddings: { '1d': null, '2d': { key: 'umap', columns: null }, '3d': null },
  geneNames: 'column:symbol',
  vectorFields: [],
});

function identityFor(fields, mapping = EXPORT_MAPPING) {
  return withManager(fields, () => {
    const controller = Object.create(GenesPanelController.prototype);
    controller.dataLayer = { state: { getDataMapping: () => mapping } };
    return controller._getCacheIdentity();
  });
}

test('a reload under the same dataset id without an export timestamp is a new generation', () => {
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
  assert.equal(first.persistent, false);
  assert.equal(reloaded.persistent, false);
  assert.notEqual(first.key, reloaded.key);
});

test('a published export timestamp identifies the generation across loads', () => {
  const first = identityFor({
    activeDatasetId: 'pbmc',
    activeDatasetMetadata: { id: 'pbmc', created_at: '2026-01-01T00:00:00Z' },
    _selectionRevision: 1,
  });
  const sameExport = identityFor({
    activeDatasetId: 'pbmc',
    activeDatasetMetadata: { id: 'pbmc', created_at: '2026-01-01T00:00:00Z' },
    _selectionRevision: 9,
  });
  const reExported = identityFor({
    activeDatasetId: 'pbmc',
    activeDatasetMetadata: { id: 'pbmc', created_at: '2026-02-01T00:00:00Z' },
    _selectionRevision: 9,
  });
  assert.deepEqual(first, sameExport);
  assert.equal(first.persistent, true);
  assert.notEqual(first.key, reExported.key);
});

test('markers from one generation are never served to another under the same dataset id', async () => {
  const cache = new MarkerCache({
    identity: { key: JSON.stringify(['load', 'adata', 1]), persistent: false },
  });
  await cache.set('cell_type', { marker: 'GENE_ONLY_IN_V1' }, PARAMS);
  assert.deepEqual(await cache.get('cell_type', PARAMS), { marker: 'GENE_ONLY_IN_V1' });

  cache.setIdentity({ key: JSON.stringify(['load', 'adata', 2]), persistent: false });
  assert.equal(await cache.get('cell_type', PARAMS), null);
});

test('a generation that cannot prove itself across page loads never touches IndexedDB', async () => {
  const cache = new MarkerCache({
    identity: { key: JSON.stringify(['load', 'adata', 1]), persistent: false },
  });
  const forbidden = () => {
    throw new Error('IndexedDB must not be used for a page-local generation');
  };
  cache._db = { transaction: forbidden, close() {} };
  cache._getFromIndexedDB = forbidden;
  cache._setInIndexedDB = forbidden;
  await cache.set('cell_type', { marker: 'x' }, PARAMS);
  assert.deepEqual(await cache.get('cell_type', PARAMS), { marker: 'x' });
  assert.equal(await cache.has('cell_type', PARAMS), true);
});

test('another gene list under the same dataset generation is another identity', () => {
  const exported = { activeDatasetId: 'pbmc', activeDatasetMetadata: { id: 'pbmc', created_at: '2026-01-01T00:00:00Z' }, _selectionRevision: 1 };
  const bySymbol = identityFor(exported);
  const byId = identityFor(exported, { ...EXPORT_MAPPING, geneNames: 'column:gene_id' });
  assert.equal(byId.persistent, true);
  assert.notEqual(bySymbol.key, byId.key);

  const file = { activeDatasetId: 'local-user:h5ad:adata', activeDatasetMetadata: { id: 'adata' }, _selectionRevision: 3 };
  const anndata = {
    kind: 'anndata',
    embeddings: { '1d': null, '2d': { key: 'X_umap', columns: [0, 1] }, '3d': null },
    knn: null,
    geneNames: 'index',
    expression: 'X',
    latent: null,
    vectorFields: [],
  };
  const onX = identityFor(file, anndata);
  const onRaw = identityFor(file, { ...anndata, expression: 'raw' });
  assert.notEqual(onX.key, onRaw.key);
  assert.equal(onX.key, identityFor(file, anndata).key);
});
