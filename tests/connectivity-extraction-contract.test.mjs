import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import { loaderMetadata, obsmColumnReader, withObsmPayloads } from './helpers/anndata-mapping-mocks.mjs';
import {
  loadConnectivitySummary,
  loadEdges,
} from '../assets/js/data/data-loaders.js';
import {
  getDataSourceManager,
} from '../assets/js/data/data-source-manager.js';
import { AnnDataFileSource } from '../assets/js/data/anndata-file-source.js';
import {
  extractConnectivityEdges,
} from '../assets/js/data/connectivity-edges.js';
import { connectivityEdgesOf } from '../assets/js/data/connectivity-edges.js';
import { edgeWeightsFrom, edgeWeightsOf, edgeListOf } from './helpers/connectivity-edges.mjs';

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

  assert.deepEqual(Array.from(edgeListOf(edges).sources), [0, 1]);
  assert.deepEqual(Array.from(edgeListOf(edges).destinations), [1, 2]);
  assert.deepEqual(edgeWeightsOf(edges), edgeWeightsFrom([1, 2]));
});

test('dense direct connectivity requires exact weighted symmetry and zero diagonal', async t => {
  const valid = dense([
    0, 1,
    1, 0,
  ]);
  const snapshot = valid.data.slice();
  const edges = extractConnectivityEdges(valid, 2);
  assert.deepEqual(Array.from(edgeListOf(edges).sources), [0]);
  assert.deepEqual(Array.from(edgeListOf(edges).destinations), [1]);
  assert.deepEqual(edgeWeightsOf(edges), edgeWeightsFrom([1]));
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
  assert.deepEqual(Array.from(edgeListOf(edges).sources), [0, 0]);
  assert.deepEqual(Array.from(edgeListOf(edges).destinations), [1, 2]);
  assert.deepEqual(edgeWeightsOf(edges), edgeWeightsFrom([1, 2]));
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

  await t.test('explicit sparse zeros are not edges', () => {
    // Other tools keep stored zeros; each is dropped, as if it were not
    // stored, after the duplicate check every stored coordinate takes part in.
    const none = extractConnectivityEdges(
      sparse({
        data: [0, 0],
        indices: [1, 0],
        indptr: [0, 1, 2],
      }),
      2
    );
    assert.equal(edgeListOf(none).sources.length, 0);

    // 3 cells: a real 0-1 edge, stored zeros at 0-2 (both sides), 1-2 (one
    // side) and on the diagonal.
    const mixed = extractConnectivityEdges(
      sparse({
        data: [0, 0.5, 0, 0.5, 0, 0],
        indices: [0, 1, 2, 0, 2, 0],
        indptr: [0, 3, 5, 6],
        shape: [3, 3],
      }),
      3
    );
    assert.deepEqual(Array.from(edgeListOf(mixed).sources), [0]);
    assert.deepEqual(Array.from(edgeListOf(mixed).destinations), [1]);
    assert.deepEqual(edgeWeightsOf(mixed), edgeWeightsFrom([0.5]));

    assert.throws(
      () => extractConnectivityEdges(
        sparse({
          data: [0, 0.5, 0.5],
          indices: [1, 1, 0],
          indptr: [0, 2, 3],
        }),
        2
      ),
      /duplicate coordinate/i
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
    connectivityCalls: 0,
    async getDatasetMetadata() {
      return loaderMetadata({
        nObs: 2,
        obsm: { X_umap_2d: 2 },
        // The loader lists obsp['connectivities'] exactly when it has one.
        connectivities: connectivity !== null,
        stats: { n_edges: null },
      });
    },
    readObsmColumns: obsmColumnReader({
      X_umap_2d: { data: [0, 0, 1, 1], width: 2 },
    }),
    async hasConnectivities() {
      return connectivity !== null;
    },
    async getConnectivityEdges() {
      return connectivityEdgesOf(await this.readConnectivityMatrix(), this.nObs);
    },
    async readConnectivityMatrix() {
      this.connectivityCalls++;
      return connectivity;
    },
    close() {},
  };
}

async function finalizeDirect(format, connectivity, id) {
  const loader = createDirectLoader(connectivity);
  const adapter = new BaseAnnDataAdapter(withObsmPayloads(loader));
  await adapter.initialize();
  const identity = await adapter.finalizeDirectIdentity({
    id,
    name: id,
    preferFileName: false,
    description: `Exact ${format} connectivity fixture`,
    source: {
      name: format === 'h5ad' ? 'H5AD file' : 'Zarr store',
      filename: format === 'h5ad'
        ? `${id}.h5ad`
        : `${id}.zarr`,
    },
  });
  const source = new AnnDataFileSource();
  source._loader = loader;
  source._adapter = adapter;
  source._metadata = identity;
  source.datasetId = id;
  source.format = format;
  source.filename = format === 'h5ad' ? `${id}.h5ad` : `${id}.zarr`;
  return { adapter, identity, loader, source };
}

test('H5AD and Zarr open without reading the graph and refuse an inexact one when its edges are read', async t => {
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
        const { adapter, identity, loader } = await finalizeDirect(
          format,
          matrix,
          `invalid-${format}-${name}`
        );
        assert.equal(identity.stats.has_connectivity, true);
        assert.equal(identity.stats.n_edges, null);
        assert.equal(loader.connectivityCalls, 0, 'opening never reads the graph');
        await assert.rejects(adapter.getConnectivityEdges(), expectedError);
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
      assert.equal(identity.stats.n_edges, null, 'counted when the edges are read');
      const edges = await adapter.getConnectivityEdges();
      assert.equal(edges.nEdges, 1);
      assert.deepEqual(Array.from(edgeListOf(edges).sources), [0]);
      assert.deepEqual(Array.from(edgeListOf(edges).destinations), [1]);
      assert.deepEqual(edgeWeightsOf(edges), edgeWeightsFrom([2]));
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
        n_edges: null,
      });
      assert.equal(loader.connectivityCalls, 0, 'opening never reads the graph');
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
        const graphUrl = `anndata://${id}/obsp`;
        const summary = await loadConnectivitySummary(
          graphUrl,
          { signal }
        );
        assert.deepEqual(summary, {
          n_cells: 2,
          n_edges: null,
          max_neighbors: null,
        });
        assert.equal(Object.isFrozen(summary), true);
        assert.equal(
          loader.connectivityCalls,
          callsAfterFinalization,
          'reading the summary must remain metadata-only'
        );

        const edges = await loadEdges(
          graphUrl,
          summary,
          { signal }
        );
        assert.deepEqual(edges, await adapter.getConnectivityEdges());
        assert.equal(
          loader.connectivityCalls,
          callsAfterFinalization + 1,
          'the graph is read once, when its edges are first asked for'
        );
        assert.equal(edges.nCells, 2);
        assert.equal(edges.nEdges, 0);
        assert.equal(edges.maxNeighbors, 0);
        assert.deepEqual(Array.from(edgeListOf(edges).sources), []);
        assert.deepEqual(Array.from(edgeListOf(edges).destinations), []);
        assert.deepEqual(edgeWeightsOf(edges), edgeWeightsFrom([]));
      } finally {
        manager.activeSource = previous.activeSource;
        manager.activeDatasetId = previous.activeDatasetId;
        manager.activeDatasetMetadata =
          previous.activeDatasetMetadata;
      }
    });
  }
});

test('symmetry is checked entry by entry in one pass, in CSR and CSC, unsorted lines included', () => {
  const csr = (indptr, indices, data, format = 'csr') => ({
    format, shape: [3, 3], indptr: Int32Array.from(indptr), indices: Int32Array.from(indices), data: Float32Array.from(data),
  });
  // 0-1 (w 2) and 1-2 (w 3), symmetric; line 1 stored unsorted.
  for (const format of ['csr', 'csc']) {
    const graph = csr([0, 1, 3, 4], [1, 2, 0, 1], [2, 3, 2, 3], format);
    const before = Array.from(graph.indices);
    const edges = extractConnectivityEdges(graph, 3);
    assert.deepEqual(Array.from(edgeListOf(edges).sources), [0, 1], format);
    assert.deepEqual(Array.from(edgeListOf(edges).destinations), [1, 2], format);
    assert.deepEqual(edgeWeightsOf(edges), edgeWeightsFrom([2, 3]), format);
    assert.deepEqual(Array.from(graph.indices), before, `${format}: the input is not changed`);
  }
  const asymmetric = /exactly symmetric/;
  // An upper entry without its partner.
  assert.throws(() => extractConnectivityEdges(csr([0, 1, 1, 1], [1], [2]), 3), asymmetric);
  // A lower entry without its partner.
  assert.throws(() => extractConnectivityEdges(csr([0, 0, 1, 1], [0], [2]), 3), asymmetric);
  // Partners with different weights.
  assert.throws(() => extractConnectivityEdges(csr([0, 1, 2, 2], [1, 0], [2, 5]), 3), asymmetric);
  // A stored zero is no edge and needs no partner.
  const zero = extractConnectivityEdges(csr([0, 2, 3, 3], [1, 2, 0], [2, 0, 2]), 3);
  assert.deepEqual([Array.from(edgeListOf(zero).sources), Array.from(edgeListOf(zero).destinations)], [[0], [1]]);
  // A duplicate coordinate, even unsorted.
  assert.throws(() => extractConnectivityEdges(csr([0, 2, 3, 3], [1, 1, 0], [2, 2, 2]), 3), /duplicate coordinate/);
});
