import assert from 'node:assert/strict';
import test from 'node:test';

import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import {
  loadConnectivityManifest,
  loadEdges,
} from '../assets/js/data/data-loaders.js';
import {
  getDataSourceManager,
} from '../assets/js/data/data-source-manager.js';
import { H5adDataSource } from '../assets/js/data/h5ad.js';
import {
  extractConnectivityEdges,
} from '../assets/js/data/sparse-utils.js';
import { ZarrDataSource } from '../assets/js/data/zarr.js';

function dense(values) {
  return {
    format: 'dense',
    shape: [2, 2],
    data: Float32Array.from(values),
  };
}

function sparse({
  data,
  indices,
  indptr,
  format = 'csr',
  shape = [2, 2],
}) {
  return {
    format,
    shape,
    data: Float64Array.from(data),
    indices: Int32Array.from(indices),
    indptr: Int32Array.from(indptr),
  };
}

test('official AnnData-style weighted connectivity is preserved exactly', () => {
  const matrix = {
    format: 'dense',
    shape: [3, 3],
    data: Float32Array.from([
      0, 1, 0,
      1, 0, 2,
      0, 2, 0,
    ]),
  };
  const edges = extractConnectivityEdges(matrix, 3);

  assert.deepEqual(Array.from(edges.sources), [0, 1]);
  assert.deepEqual(Array.from(edges.destinations), [1, 2]);
  assert.deepEqual(Array.from(edges.weights), [1, 2]);
});

test('dense direct connectivity requires exact weighted symmetry and zero diagonal', async t => {
  const valid = dense([
    0, 1,
    1, 0,
  ]);
  const snapshot = valid.data.slice();
  const edges = extractConnectivityEdges(valid, 2);
  assert.deepEqual(Array.from(edges.sources), [0]);
  assert.deepEqual(Array.from(edges.destinations), [1]);
  assert.deepEqual(Array.from(edges.weights), [1]);
  assert.deepEqual(valid.data, snapshot, 'extraction must not mutate input');

  const invalid = [
    [
      'negative weight',
      dense([
        0, -0.5,
        -0.5, 0,
      ]),
      /weights.*non-negative/i,
    ],
    [
      'directed',
      dense([
        0, 1,
        0, 0,
      ]),
      /exactly symmetric/i,
    ],
    [
      'diagonal',
      dense([
        1, 0,
        0, 0,
      ]),
      /diagonal.*exactly zero/i,
    ],
    [
      'non-finite',
      dense([
        0, Number.NaN,
        Number.NaN, 0,
      ]),
      /all be finite/i,
    ],
  ];
  for (const [name, matrix, expectedError] of invalid) {
    await t.test(name, () => {
      assert.throws(
        () => extractConnectivityEdges(matrix, 2),
        expectedError
      );
    });
  }
});

test('sparse direct connectivity is exact, canonical, and non-mutating', async t => {
  const matrix = sparse({
    data: [2, 1, 1, 2],
    indices: [2, 1, 0, 0],
    indptr: [0, 2, 3, 4],
    shape: [3, 3],
  });
  const snapshots = {
    data: matrix.data.slice(),
    indices: matrix.indices.slice(),
    indptr: matrix.indptr.slice(),
  };
  const edges = extractConnectivityEdges(matrix, 3);
  assert.deepEqual(Array.from(edges.sources), [0, 0]);
  assert.deepEqual(Array.from(edges.destinations), [1, 2]);
  assert.deepEqual(Array.from(edges.weights), [1, 2]);
  assert.deepEqual(matrix.data, snapshots.data);
  assert.deepEqual(matrix.indices, snapshots.indices);
  assert.deepEqual(matrix.indptr, snapshots.indptr);

  const invalid = [
    [
      'mismatched symmetric weights',
      sparse({
        data: [0.25, 0.5],
        indices: [1, 0],
        indptr: [0, 1, 2],
      }),
      /weights.*exactly symmetric/i,
    ],
    [
      'directed',
      sparse({
        data: [1],
        indices: [1],
        indptr: [0, 1, 1],
      }),
      /exactly symmetric/i,
    ],
    [
      'diagonal',
      sparse({
        data: [1],
        indices: [0],
        indptr: [0, 1, 1],
      }),
      /diagonal.*exactly zero/i,
    ],
    [
      'duplicate coordinate',
      sparse({
        data: [1, 1, 1],
        indices: [1, 1, 0],
        indptr: [0, 2, 3],
      }),
      /duplicate.*coordinate/i,
    ],
    [
      'non-finite',
      sparse({
        data: [Number.POSITIVE_INFINITY, 1],
        indices: [1, 0],
        indptr: [0, 1, 2],
      }),
      /all be finite/i,
    ],
  ];
  for (const [name, candidate, expectedError] of invalid) {
    await t.test(name, () => {
      assert.throws(
        () => extractConnectivityEdges(candidate, 2),
        expectedError
      );
    });
  }

  await t.test('missing values are not implicit ones', () => {
    const candidate = sparse({
      data: [],
      indices: [1, 0],
      indptr: [0, 1, 2],
    });
    delete candidate.data;
    assert.throws(
      () => extractConnectivityEdges(candidate, 2),
      /data.*required/i
    );
  });

  await t.test('explicit sparse zeros are rejected instead of dropped', () => {
    assert.throws(
      () => extractConnectivityEdges(
        sparse({
          data: [0, 0],
          indices: [1, 0],
          indptr: [0, 1, 2],
        }),
        2
      ),
      /omit zero-weight coordinates/i
    );
  });

  await t.test('empty payload still requires exact pointers', () => {
    assert.throws(
      () => extractConnectivityEdges(
        sparse({
          data: [],
          indices: [],
          indptr: [0, 1, 0],
        }),
        2
      ),
      /pointers.*span|monotonic/i
    );
  });
});

function createDirectLoader(connectivity) {
  return {
    nObs: 2,
    nVars: 0,
    hasExpressionMatrix: false,
    varNames: [],
    obsKeys: [],
    obsmKeys: ['X_umap_2d'],
    connectivityCalls: 0,
    async getDatasetMetadata() {
      return {
        version: 2,
        name: 'private-loader-metadata',
        description: '',
        cellucid_data_version: 'private-loader',
        stats: {
          n_cells: 2,
          n_genes: 0,
          n_obs_fields: 0,
          n_categorical_fields: 0,
          n_continuous_fields: 0,
          has_connectivity: true,
          n_edges: null,
        },
        embeddings: {
          available_dimensions: [2],
          default_dimension: 2,
          obsm_keys: { '2d': 'X_umap_2d' },
          has_expression_matrix: false,
        },
        obs_fields: [],
      };
    },
    async getEmbeddingShape(key) {
      assert.equal(key, 'X_umap_2d');
      return { nCells: 2, nDims: 2 };
    },
    async getEmbedding(key) {
      assert.equal(key, 'X_umap_2d');
      return {
        data: Float32Array.from([0, 0, 1, 1]),
        nDims: 2,
      };
    },
    releaseEmbedding() {},
    async getConnectivities() {
      this.connectivityCalls++;
      return connectivity;
    },
    close() {},
  };
}

async function finalizeDirect(format, connectivity, id) {
  const loader = createDirectLoader(connectivity);
  const adapter = new BaseAnnDataAdapter(loader);
  await adapter.initialize();
  const identity = await adapter.finalizeDirectIdentity({
    id,
    name: id,
    description: `Exact ${format} connectivity fixture`,
    cellucidDataVersion: `${format}_loader`,
    source: {
      name: format === 'h5ad' ? 'H5AD file' : 'Zarr store',
      filename: format === 'h5ad'
        ? `${id}.h5ad`
        : `${id}.zarr`,
    },
  });
  const source = format === 'h5ad'
    ? new H5adDataSource()
    : new ZarrDataSource();
  source._loader = loader;
  source._adapter = adapter;
  source._metadata = identity;
  source.datasetId = id;
  if (format === 'h5ad') {
    source.filename = `${id}.h5ad`;
  } else {
    source.dirname = `${id}.zarr`;
  }
  return { adapter, identity, loader, source };
}

test('H5AD and Zarr reject inexact graphs before direct identity publication', async t => {
  const invalid = [
    [
      'negative weight',
      dense([
        0, -0.5,
        -0.5, 0,
      ]),
      /weights.*non-negative/i,
    ],
    [
      'directed',
      dense([
        0, 1,
        0, 0,
      ]),
      /exactly symmetric/i,
    ],
    [
      'diagonal',
      dense([
        1, 0,
        0, 0,
      ]),
      /diagonal.*exactly zero/i,
    ],
    [
      'malformed sparse storage',
      {
        format: 'csr',
        shape: [2, 2],
        data: Float32Array.from([1, 1]),
        indices: Int32Array.from([1, 0]),
      },
      /storage.*invalid|pointer/i,
    ],
    [
      'undefined connectivity response',
      undefined,
      /exact null.*matrix object/i,
    ],
  ];
  for (const format of ['h5ad', 'zarr']) {
    for (const [name, matrix, expectedError] of invalid) {
      await t.test(`${format} ${name}`, async () => {
        await assert.rejects(
          finalizeDirect(
            format,
            matrix,
            `invalid-${format}-${name}`
          ),
          expectedError
        );
      });
    }
  }
});

test('H5AD and Zarr publish exact numeric weights through their adapters', async t => {
  for (const format of ['h5ad', 'zarr']) {
    await t.test(format, async () => {
      const { adapter, identity } = await finalizeDirect(
        format,
        dense([
          0, 2,
          2, 0,
        ]),
        `${format}-weighted-connectivity`
      );
      assert.equal(identity.stats.has_connectivity, true);
      assert.equal(identity.stats.n_edges, 1);
      const edges = await adapter.getConnectivityEdges();
      assert.deepEqual(Array.from(edges.sources), [0]);
      assert.deepEqual(Array.from(edges.destinations), [1]);
      assert.deepEqual(Array.from(edges.weights), [2]);
    });
  }
});

test('H5AD and Zarr explicit empty graphs stay present end to end', async t => {
  for (const format of ['h5ad', 'zarr']) {
    await t.test(format, async () => {
      const id = `${format}-empty-connectivity`;
      const {
        adapter,
        identity,
        loader,
        source,
      } = await finalizeDirect(
        format,
        dense([0, 0, 0, 0]),
        id
      );
      assert.deepEqual(identity.stats, {
        n_cells: 2,
        n_genes: 0,
        n_obs_fields: 0,
        n_categorical_fields: 0,
        n_continuous_fields: 0,
        has_connectivity: true,
        n_edges: 0,
      });
      const callsAfterFinalization = loader.connectivityCalls;

      const manager = getDataSourceManager();
      const previous = {
        activeSource: manager.activeSource,
        activeDatasetId: manager.activeDatasetId,
        activeDatasetMetadata: manager.activeDatasetMetadata,
      };
      manager.activeSource = source;
      manager.activeDatasetId = id;
      manager.activeDatasetMetadata = identity;
      try {
        const signal = new AbortController().signal;
        const graphUrl =
          `${format}://${id}/connectivity_manifest.json`;
        const manifest = await loadConnectivityManifest(
          graphUrl,
          { signal }
        );
        assert.deepEqual(manifest, {
          format: 'edge_pairs',
          n_cells: 2,
          n_edges: 0,
          max_neighbors: 0,
          index_dtype: 'uint32',
          index_bytes: 4,
        });
        assert.equal(Object.isFrozen(manifest), true);
        assert.equal(
          loader.connectivityCalls,
          callsAfterFinalization,
          'manifest access must remain metadata-only'
        );

        const edges = await loadEdges(
          graphUrl,
          manifest,
          { signal }
        );
        assert.deepEqual(edges, await adapter.getConnectivityEdges());
        assert.equal(
          loader.connectivityCalls,
          callsAfterFinalization,
          'edge access must reuse the finalized direct payload'
        );
        assert.equal(edges.nCells, 2);
        assert.equal(edges.nEdges, 0);
        assert.equal(edges.maxNeighbors, 0);
        assert.deepEqual(Array.from(edges.sources), []);
        assert.deepEqual(Array.from(edges.destinations), []);
        assert.deepEqual(Array.from(edges.weights), []);
      } finally {
        manager.activeSource = previous.activeSource;
        manager.activeDatasetId = previous.activeDatasetId;
        manager.activeDatasetMetadata =
          previous.activeDatasetMetadata;
      }
    });
  }
});
