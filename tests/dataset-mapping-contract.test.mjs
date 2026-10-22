import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describeEmbeddingRef,
  layoutEmbeddingRef,
  resolveAnnDataMapping,
  resolveEmbeddingRefLayout,
  resolveExportDataMapping,
} from '../assets/js/data/dataset-mapping.js';
import {
  assembleAnnDataCandidates,
  describeAnnDataProbes,
} from '../assets/js/data/data-mapping-candidates.js';
import { createDimensionManager } from '../assets/js/data/dimension-manager.js';
import { validateDataMapping } from '../assets/js/data/data-mapping.js';

function exportIdentity() {
  return {
    stats: { n_cells: 3, n_genes: 2, has_connectivity: true, n_edges: 1 },
    embeddings: {
      default_dimension: 3,
      defaults: { '2d': 'X_umap', '3d': 'X_umap_3d' },
      items: {
        X_tsne: {
          label: 't-SNE', dimension: 2, file: 'embeddings/0_2d.bin',
          source: { key: 'X_tsne', columns: [0, 1] },
        },
        X_umap: {
          label: 'UMAP', dimension: 2, file: 'embeddings/1_2d.bin',
          source: { key: null, columns: [0, 1] },
        },
        X_umap_3d: {
          label: 'UMAP', dimension: 3, file: 'embeddings/2_3d.bin',
          source: { key: 'X_umap_3d', columns: [0, 1, 2] },
        },
      },
    },
    vector_fields: {
      default_field: 'velocity',
      fields: {
        drift: { label: 'drift', files: { X_tsne: 'vectors/0_0.bin' } },
        velocity: {
          label: 'velocity',
          files: { X_umap: 'vectors/1_1.bin', X_umap_3d: 'vectors/1_2.bin' },
        },
      },
    },
  };
}

function varManifest(source) {
  return { geneNameSets: [{ source, names: ['A', 'B'], filledFromIndex: 0, renamed: [] }] };
}

test('an export enables every embedding, defaults each dimension, and binds every declared field', () => {
  const mapping = resolveExportDataMapping(exportIdentity(), varManifest('gene_symbols'));
  assert.deepEqual(mapping, {
    kind: 'export',
    embeddings: {
      enabled: [
        { key: 'X_tsne', columns: null },
        { key: 'X_umap', columns: null },
        { key: 'X_umap_3d', columns: null },
      ],
      defaults: {
        '1d': null,
        '2d': { key: 'X_umap', columns: null },
        '3d': { key: 'X_umap_3d', columns: null },
      },
    },
    geneNames: 'column:gene_symbols',
    vectorFields: [
      { field: 'drift', embedding: { key: 'X_tsne', columns: null } },
      { field: 'velocity', embedding: { key: 'X_umap', columns: null } },
      { field: 'velocity', embedding: { key: 'X_umap_3d', columns: null } },
    ],
  });
  assert.deepEqual(validateDataMapping(mapping), mapping);
});

test('an export without genes names its genes by the index', () => {
  const identity = exportIdentity();
  delete identity.vector_fields;
  const mapping = resolveExportDataMapping(identity, null);
  assert.equal(mapping.geneNames, 'index');
  assert.deepEqual(mapping.vectorFields, []);
});

function directIdentity() {
  return {
    stats: { n_cells: 3, n_genes: 2, has_connectivity: true, n_edges: 1 },
    embeddings: {
      default_dimension: 3,
      defaults: { '2d': 'X_umap_2d', '3d': 'X_umap_3d' },
      items: {
        X_umap_2d: {
          label: 'X_umap_2d', dimension: 2, file: 'embeddings/0_2d.bin',
          source: { key: 'X_umap_2d', columns: [0, 1] },
        },
        X_umap_3d: {
          label: 'X_umap_3d', dimension: 3, file: 'embeddings/1_3d.bin',
          source: { key: 'X_umap_3d', columns: [0, 1, 2] },
        },
      },
    },
    vector_fields: {
      default_field: 'velocity_umap',
      fields: {
        velocity_umap: {
          label: 'velocity_umap',
          files: { X_umap_2d: 'vectors/0_0.bin', X_umap_3d: 'vectors/0_1.bin' },
        },
      },
    },
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
  };
}

function directCandidates(options) {
  return assembleAnnDataCandidates(describeAnnDataProbes(directProbes(options)), {
    slots: {
      '1d': null,
      '2d': { key: 'X_umap_2d', columns: [0, 1] },
      '3d': { key: 'X_umap_3d', columns: [0, 1, 2] },
    },
    guessed: [],
  });
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
    latent: null,
    vectorFields: [
      { key: 'velocity_umap_2d', embedding: { key: 'X_umap_2d', columns: [0, 1] } },
      { key: 'velocity_umap_3d', embedding: { key: 'X_umap_3d', columns: [0, 1, 2] } },
    ],
  });
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

test('layouts are named per kind and named references resolve back to them', () => {
  const manager = registry(exportIdentity());
  assert.deepEqual(
    layoutEmbeddingRef(manager, 'X_tsne', 'export'),
    { key: 'X_tsne', columns: null }
  );
  assert.deepEqual(
    layoutEmbeddingRef(manager, 'X_tsne', 'anndata'),
    { key: 'X_tsne', columns: [0, 1] }
  );
  assert.throws(
    () => layoutEmbeddingRef(manager, 'X_umap', 'anndata'),
    /no AnnData obsm provenance/
  );
  assert.equal(
    resolveEmbeddingRefLayout(manager, { key: 'X_tsne', columns: null }, 'export', 2, 'ref'),
    'X_tsne'
  );
  assert.equal(
    resolveEmbeddingRefLayout(manager, { key: 'X_tsne', columns: null }, 'export', 3, 'ref'),
    null
  );
  assert.equal(
    resolveEmbeddingRefLayout(manager, { key: 'missing', columns: null }, 'export', null, 'ref'),
    null
  );
  assert.equal(
    resolveEmbeddingRefLayout(manager, { key: 'X_umap_3d', columns: [0, 1, 2] }, 'anndata', 3, 'ref'),
    'X_umap_3d'
  );
  assert.equal(
    resolveEmbeddingRefLayout(manager, { key: 'X_umap_3d', columns: [2, 1, 0] }, 'anndata', 3, 'ref'),
    null
  );
  assert.throws(
    () => resolveEmbeddingRefLayout(manager, { key: 'X_tsne', columns: [0, 1] }, 'export', 2, 'ref'),
    /columns/
  );
});

test('embedding references read the way a refusal names them', () => {
  assert.equal(describeEmbeddingRef({ key: 'X_tsne', columns: null }), "embedding 'X_tsne'");
  assert.equal(
    describeEmbeddingRef({ key: 'X_pca', columns: [3, 1] }),
    "obsm['X_pca'] columns [3, 1]"
  );
});
