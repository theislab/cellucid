import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describeEmbeddingRef,
  layoutEmbeddingRef,
  resolveAnnDataMapping,
  resolveEmbeddingRefLayout,
} from '../assets/js/data/dataset-mapping.js';
import {
  assembleAnnDataCandidates,
  describeAnnDataProbes,
} from '../assets/js/data/data-mapping-candidates.js';
import {
  createDimensionManager,
  createInMemoryDimensionManager,
} from '../assets/js/data/dimension-manager.js';
import { validateDataMapping } from '../assets/js/data/data-mapping.js';

function layoutIdentity() {
  return {
    stats: { n_cells: 3, n_genes: 2, has_connectivity: true, n_edges: 1 },
    embeddings: {
      default_dimension: 3,
      defaults: { '2d': 'X_umap', '3d': 'X_umap_3d' },
      items: {
        X_tsne: {
          label: 't-SNE', dimension: 2, path: 'obsm/0/0-1',
          source: { key: 'X_tsne', columns: [0, 1] },
        },
        X_umap: {
          label: 'UMAP', dimension: 2, path: 'obsm/1/0-1',
          source: { key: 'X_umap', columns: [0, 1] },
        },
        X_umap_3d: {
          label: 'UMAP', dimension: 3, path: 'obsm/2/0-1-2',
          source: { key: 'X_umap_3d', columns: [0, 1, 2] },
        },
      },
    },
  };
}

function directIdentity() {
  return {
    stats: { n_cells: 3, n_genes: 2, has_connectivity: true, n_edges: 1 },
    embeddings: {
      default_dimension: 3,
      defaults: { '2d': 'X_umap_2d', '3d': 'X_umap_3d' },
      items: {
        X_umap_2d: {
          label: 'X_umap_2d', dimension: 2, path: 'obsm/0/0-1',
          source: { key: 'X_umap_2d', columns: [0, 1] },
        },
        X_umap_3d: {
          label: 'X_umap_3d', dimension: 3, path: 'obsm/1/0-1-2',
          source: { key: 'X_umap_3d', columns: [0, 1, 2] },
        },
      },
    },
    vector_field_default: 'velocity_umap',
  };
}

function directProbes({ connectivities = true, hasX = true } = {}) {
  const dense = (key, width) => ({
    key, storage: 'dense', shape: [3, width], dtype: 'float32', numeric: true,
  });
  return {
    nObs: 3,
    nVars: 2,
    obsm: [
      dense('X_umap_2d', 2),
      dense('X_umap_3d', 3),
      dense('velocity_umap_2d', 2),
      dense('velocity_umap_3d', 3),
    ],
    obsp: connectivities
      ? [{ key: 'connectivities', storage: 'csr', shape: [3, 3], dtype: 'float32', numeric: true, nnz: 2 }]
      : [],
    varColumns: [],
    X: hasX ? { storage: 'dense', dtype: 'float32' } : null,
    layers: [],
    raw: null,
    log1p: null,
  };
}

function directCandidates(options, geneNameColumns = { X: null }) {
  return assembleAnnDataCandidates(describeAnnDataProbes(directProbes(options)), {
    slots: {
      '1d': null,
      '2d': { key: 'X_umap_2d', columns: [0, 1] },
      '3d': { key: 'X_umap_3d', columns: [0, 1, 2] },
    },
    guessed: [],
  }, {}, geneNameColumns);
}

test('a file opened in the browser maps by the defaults of the catalog the viewer built', () => {
  const mapping = resolveAnnDataMapping(directCandidates(), directIdentity());
  assert.deepEqual(mapping, {
    kind: 'anndata',
    // The slots are the defaults; every other plottable narrow array would be
    // enabled beside them (the vector-field arrays are not embeddings).
    embeddings: {
      enabled: [
        { key: 'X_umap_2d', columns: [0, 1] },
        { key: 'X_umap_3d', columns: [0, 1, 2] },
      ],
      defaults: {
        '1d': null,
        '2d': { key: 'X_umap_2d', columns: [0, 1] },
        '3d': { key: 'X_umap_3d', columns: [0, 1, 2] },
      },
    },
    knn: 'connectivities',
    geneNames: 'index',
    expression: 'X',
    log1p: {},
    highlyVariable: null,
    latent: null,
    vectorFields: [
      { key: 'velocity_umap_2d', embedding: { key: 'X_umap_2d', columns: [0, 1] } },
      { key: 'velocity_umap_3d', embedding: { key: 'X_umap_3d', columns: [0, 1, 2] } },
    ],
  });
});

test('a file opened before its gene names are guessed maps them as pending, never as the index', () => {
  // As a dataset opens: the first view reads no gene name.
  const candidates = directCandidates(undefined, {});
  assert.equal(candidates.defaults.geneNames, null);
  assert.equal(candidates.guessed.includes('geneNames'), false);
  const mapping = resolveAnnDataMapping(candidates, directIdentity());
  assert.equal(mapping.geneNames, null);
  // Nothing outside the opening admits it.
  assert.throws(() => validateDataMapping(mapping), /geneNames must be "index" or "column:<var column>"/);
  // Once the shown axis is guessed, the default is its own.
  assert.equal(directCandidates(undefined, { X: null }).defaults.geneNames, 'index');
});

test('a file without connectivity or an X matrix maps no graph and no expression', () => {
  const mapping = resolveAnnDataMapping(
    directCandidates({ connectivities: false, hasX: false }),
    directIdentity()
  );
  assert.equal(mapping.knn, null);
  assert.equal(mapping.expression, null);
});

test('a served mapping is read from the catalog and must agree with the identity', () => {
  const served = {
    kind: 'anndata',
    embeddings: {
      enabled: [
        { key: 'X_pca', columns: [0, 1] },
        { key: 'X_umap_2d', columns: [0, 1] },
        { key: 'X_umap_3d', columns: [0, 1, 2] },
      ],
      defaults: {
        '1d': null,
        '2d': { key: 'X_umap_2d', columns: [0, 1] },
        '3d': { key: 'X_umap_3d', columns: [0, 1, 2] },
      },
    },
    knn: 'neighbors_connectivities',
    geneNames: 'column:symbol',
    expression: 'raw',
    log1p: {},
    highlyVariable: null,
    latent: 'X_scvi',
    vectorFields: [],
  };
  const candidates = { kind: 'anndata', defaults: served };
  assert.deepEqual(resolveAnnDataMapping(candidates, directIdentity()), served);

  const disagreeing = structuredClone(candidates);
  // An enabled representation may be anything; the defaults are the
  // identity's embeddings.
  disagreeing.defaults.embeddings.defaults['2d'] = { key: 'X_pca', columns: [0, 1] };
  assert.throws(
    () => resolveAnnDataMapping(disagreeing, directIdentity()),
    /data mapping shows .*X_pca.* in 2d, but the dataset identity shows/
  );
  assert.throws(
    () => resolveAnnDataMapping({ kind: 'anndata' }, directIdentity()),
    /must be of kind "anndata" and state its defaults/
  );
  assert.throws(
    () => resolveAnnDataMapping(
      { kind: 'anndata', defaults: { ...served, knn: 3 } },
      directIdentity()
    ),
    /knn/
  );
});

function registry(identity) {
  const manager = createDimensionManager({ baseUrl: 'https://example.test/data/' });
  manager.initFromMetadata(identity.embeddings);
  return manager;
}

test('layouts are named by their obsm provenance and named references resolve back to them', () => {
  const manager = registry(layoutIdentity());
  assert.deepEqual(
    layoutEmbeddingRef(manager, 'X_tsne'),
    { key: 'X_tsne', columns: [0, 1] }
  );
  assert.deepEqual(
    layoutEmbeddingRef(manager, 'X_umap'),
    { key: 'X_umap', columns: [0, 1] }
  );
  // A layout made in memory (no file behind it) has no obsm key to name.
  const generated = createInMemoryDimensionManager({
    positions: new Float32Array([0, 0, 1, 1]),
    dimension: 2,
  });
  assert.throws(
    () => layoutEmbeddingRef(generated, '2d'),
    /no AnnData obsm provenance/
  );
  assert.equal(
    resolveEmbeddingRefLayout(manager, { key: 'X_tsne', columns: [0, 1] }, 2, 'ref'),
    'X_tsne'
  );
  assert.throws(
    () => resolveEmbeddingRefLayout(manager, { key: 'X_tsne', columns: [0, 1] }, 3, 'ref'),
    /exactly 3 columns/
  );
  assert.equal(
    resolveEmbeddingRefLayout(manager, { key: 'missing', columns: [0, 1] }, null, 'ref'),
    null
  );
  assert.equal(
    resolveEmbeddingRefLayout(manager, { key: 'X_umap_3d', columns: [0, 1, 2] }, 3, 'ref'),
    'X_umap_3d'
  );
  assert.equal(
    resolveEmbeddingRefLayout(manager, { key: 'X_umap_3d', columns: [2, 1, 0] }, 3, 'ref'),
    null
  );
  assert.throws(
    () => resolveEmbeddingRefLayout(manager, { key: 'X_tsne', columns: null }, 2, 'ref'),
    /columns/
  );
});

test('embedding references read the way a refusal names them', () => {
  assert.equal(
    describeEmbeddingRef({ key: 'X_pca', columns: [3, 1] }),
    "obsm['X_pca'] columns [3, 1]"
  );
});
