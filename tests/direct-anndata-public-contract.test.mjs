import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import { obsmIndexOf } from '../assets/js/data/data-mapping-candidates.js';
import { loaderMetadata, selectColumns, withObsmPayloads } from './helpers/anndata-mapping-mocks.mjs';
import {
  loadConnectivitySummary,
  loadDatasetGeneration,
  loadDatasetIdentity,
  loadEdges,
  loadObsFields,
  loadPointsBinary,
  loadGeneList,
} from '../assets/js/data/data-loaders.js';
import {
  getDataSourceManager,
} from '../assets/js/data/data-source-manager.js';
import {
  createCandidateAnnDataBinding,
} from '../assets/js/data/anndata-provider.js';
import { H5adDataSource } from '../assets/js/data/h5ad.js';
import { ZarrDataSource } from '../assets/js/data/zarr.js';
import { connectivityEdgesOf } from '../assets/js/data/connectivity-edges.js';
import { edgeWeightsFrom, edgeWeightsOf, edgeListOf } from './helpers/connectivity-edges.mjs';

const EDGE_SIGNAL = new AbortController().signal;

function denseConnectivity() {
  return {
    format: 'dense',
    shape: [3, 3],
    data: Float32Array.from([
      0, 1, 0,
      1, 0, 1,
      0, 1, 0,
    ]),
  };
}

function createDirectLoader() {
  const embeddingCalls = [];
  const embeddings = {
    X_umap_2d: {
      data: Float32Array.from([
        -2, -1,
        0, 1,
        2, 0,
      ]),
      nDims: 2,
    },
    X_umap_3d: {
      data: Float32Array.from([
        -2, -1, 0,
        0, 1, 2,
        2, 0, -2,
      ]),
      nDims: 3,
    },
    velocity_umap_2d: {
      data: Float32Array.from([
        1, 0,
        0, 1,
        -1, 0,
      ]),
      nDims: 2,
    },
    velocity_umap_3d: {
      data: Float32Array.from([
        1, 0, 0,
        0, 1, 0,
        -1, 0, 1,
      ]),
      nDims: 3,
    },
  };

  const loader = {
    nObs: 3,
    nVars: 5,
    hasExpressionMatrix: false,
    varNames: ['G0', 'G1', 'G2', 'G3', 'G4'],
    obsKeys: [
      'numeric_category',
      'boolean_category',
      'nullable_integer',
      'nullable_boolean',
      'nullable_string',
    ],
    embeddingCalls,
    connectivityCalls: 0,
    async getDatasetMetadata() {
      // The private adapter-construction descriptor H5AD/Zarr loaders
      // return; it is never published. The adapter resolves its obsm probes
      // into the public identity in finalizeDirectIdentity().
      return loaderMetadata({
        nObs: this.nObs,
        nVars: this.nVars,
        obsm: Object.fromEntries(
          Object.entries(embeddings).map(([key, value]) => [key, value.nDims])
        ),
        connectivities: true,
        stats: { n_genes: this.nVars, n_edges: null },
      });
    },
    async getObsFieldInfo(key) {
      if (key === 'numeric_category') {
        return {
          dtype: 'categorical',
          categories: [1, 2],
          ordered: false,
        };
      }
      if (key === 'boolean_category') {
        return {
          dtype: 'categorical',
          categories: [false, true],
          ordered: false,
        };
      }
      if (key === 'nullable_integer') {
        return { dtype: 'int' };
      }
      if (key === 'nullable_boolean') {
        return { dtype: 'bool' };
      }
      if (key === 'nullable_string') {
        return { dtype: 'string' };
      }
      throw new Error(`Unexpected observation field "${key}"`);
    },
    async getObsField(key) {
      if (key === 'nullable_boolean') {
        return {
          dtype: 'bool',
          values: [true, null, false],
        };
      }
      if (key === 'nullable_string') {
        return {
          dtype: 'string',
          values: ['alpha', null, 'beta'],
        };
      }
      if (key === 'numeric_category') {
        return {
          dtype: 'categorical',
          categories: [1, 2],
          codes: Int32Array.from([0, 1, 0]),
          ordered: false,
        };
      }
      if (key === 'boolean_category') {
        return {
          dtype: 'categorical',
          categories: [false, true],
          codes: Int32Array.from([0, 1, 0]),
          ordered: false,
        };
      }
      if (key === 'nullable_integer') {
        return {
          dtype: 'int',
          values: Int32Array.from([1, 2, 3]),
        };
      }
      throw new Error(`Unexpected observation field "${key}"`);
    },
    releaseObsField() {},
    async readObsmColumns(key, columns) {
      embeddingCalls.push(key);
      const embedding = embeddings[key];
      if (!embedding) {
        throw new Error(`Unexpected obsm payload request "${key}"`);
      }
      return selectColumns(embedding.data, embedding.nDims, columns);
    },
    async hasConnectivities() {
      return true;
    },
    async getConnectivityEdges() {
      return connectivityEdgesOf(await this.readConnectivityMatrix(), this.nObs);
    },
    async readConnectivityMatrix() {
      this.connectivityCalls++;
      return denseConnectivity();
    },
    async readVarNames() {
      throw new Error('X=None must not read gene names');
    },
    async getMatrixColumn() {
      throw new Error('X=None must not expose gene expression');
    },
    close() {},
  };
  return loader;
}

async function createDirectSource(format, id) {
  const loader = createDirectLoader();
  const adapter = new BaseAnnDataAdapter(withObsmPayloads(loader));
  await adapter.initialize();

  assert.deepEqual(
    loader.embeddingCalls,
    ['X_umap_3d'],
    'initial validation materializes only the advertised maximum/default embedding'
  );
  // Vector discovery reads the obsm probes, never a vector payload.
  assert.deepEqual(
    adapter.getMappingCandidates().defaults.vectorFields.map(binding => binding.key),
    ['velocity_umap_2d', 'velocity_umap_3d']
  );

  const filename = format === 'h5ad'
    ? `${id}.h5ad`
    : `${id}.zarr`;
  const identity = await adapter.finalizeDirectIdentity({
    id,
    name: id,
    preferFileName: false,
    description: `Direct ${format} contract fixture`,
    source: {
      name: format === 'h5ad' ? 'H5AD file' : 'Zarr store',
      filename,
    },
  });

  assert.deepEqual(
    loader.embeddingCalls,
    ['X_umap_3d'],
    'identity construction does not allocate non-default embeddings or vectors'
  );

  const SourceClass = format === 'h5ad'
    ? H5adDataSource
    : ZarrDataSource;
  const source = new SourceClass();
  source._loader = loader;
  source._adapter = adapter;
  source._metadata = identity;
  source.datasetId = id;
  if (format === 'h5ad') {
    source.filename = filename;
  } else {
    source.dirname = filename;
  }
  return { adapter, identity, loader, source };
}


function createLocalAnnDataCandidate(format, fixture) {
  return {
    datasetId: fixture.id,
    getAnnDataSource() {
      return fixture.source;
    },
    getType() {
      return 'local-user';
    },
  };
}

test('H5AD and Zarr publish one exact identity before direct adoption', async t => {
  for (const format of ['h5ad', 'zarr']) {
    await t.test(format, async () => {
      const id = `direct-${format}-a`;
      const {
        adapter,
        identity,
        loader,
        source,
      } = await createDirectSource(format, id);

      assert.deepEqual(Object.keys(identity).sort(), [
        'description',
        'embeddings',
        'id',
        'name',
        'obs_fields',
        'source',
        'stats',
      ]);
      // One item per resolved obsm embedding, keyed by its canonical id (the
      // obsm key), in (dimension, id) order, on its obsm route.
      assert.deepEqual(identity.embeddings, {
        default_dimension: 3,
        defaults: {
          '2d': 'X_umap_2d',
          '3d': 'X_umap_3d',
        },
        items: {
          X_umap_2d: {
            label: 'X_umap_2d',
            dimension: 2,
            path: `obsm/${obsmIndexOf(adapter.getMappingCandidates(), 'X_umap_2d')}/0-1`,
            source: { key: 'X_umap_2d', columns: [0, 1] },
          },
          X_umap_3d: {
            label: 'X_umap_3d',
            dimension: 3,
            path: `obsm/${obsmIndexOf(adapter.getMappingCandidates(), 'X_umap_3d')}/0-1-2`,
            source: { key: 'X_umap_3d', columns: [0, 1, 2] },
          },
        },
      });
      assert.deepEqual(
        Object.keys(identity.embeddings.items),
        ['X_umap_2d', 'X_umap_3d']
      );
      assert.deepEqual(identity.obs_fields, [
        { key: 'nullable_integer', kind: 'continuous' },
        {
          key: 'numeric_category',
          kind: 'category',
          n_categories: 2,
        },
        {
          key: 'boolean_category',
          kind: 'category',
          n_categories: 2,
        },
        // A boolean or string column's categories are found when it is
        // first loaded: opening counts none of them.
        {
          key: 'nullable_boolean',
          kind: 'category',
          n_categories: null,
        },
        {
          key: 'nullable_string',
          kind: 'category',
          n_categories: null,
        },
      ]);
      assert.deepEqual(identity.stats, {
        n_cells: 3,
        n_genes: 0,
        n_obs_fields: 5,
        n_categorical_fields: 4,
        n_continuous_fields: 1,
        has_connectivity: true,
        // Counted when the edges are first read: opening reads no graph.
        n_edges: null,
      });
      // The vector fields (velocity_umap_<d>d, the field `velocity` on
      // X_umap_<d>d) are the data mapping's, never the identity's.

      // A categorical field lists no centroids (they are computed in the
      // browser), and the gene list states what making its names unique
      // changed instead of var_gene_id_column.
      const obsFields = adapter.getObsFields();
      for (const field of obsFields.fields) {
        assert.equal(Object.hasOwn(field, 'centroids'), false);
      }
      const geneList = await adapter.getGeneList();
      assert.equal(Object.hasOwn(geneList, 'var_gene_id_column'), false);
      assert.deepEqual(geneList.geneNames, { source: null, filledFromIndex: 0, renamed: [] });

      // The loader's adapter-construction descriptor carries the mapping
      // probes beside the stats; they decide the embeddings and never reach
      // the published identity.
      assert.equal(
        Object.hasOwn(identity, 'probes'),
        false,
        'the loader descriptor probes must remain private'
      );
      assert.equal(
        JSON.stringify(identity).includes('"probes"'),
        false,
        'no identity member may carry the loader descriptor probes'
      );

      assert.equal(loader.nVars, 5);
      assert.deepEqual(
        loader.varNames,
        ['G0', 'G1', 'G2', 'G3', 'G4'],
        'X=None retains the private var axis'
      );
      assert.deepEqual(
        (await adapter.getGeneList()).fields,
        [],
        'X=None publishes zero expression fields'
      );
      await assert.rejects(
        adapter.getGeneValues('var/0'),
        /has no expression matrix; gene expression is unavailable/
      );

      assert.strictEqual(await source.getMetadata(id), identity);
      assert.equal(source.getBaseUrl(id), `${format}://${id}/`);
      for (const wrongId of [undefined, '', `${id}-other`]) {
        await assert.rejects(
          source.getMetadata(wrongId),
          /not the adopted dataset/
        );
        assert.throws(
          () => source.getBaseUrl(wrongId),
          /not the adopted dataset/
        );
      }

      const connectivityCallsBeforeSummary =
        loader.connectivityCalls;
      const directConnectivitySummary =
        await source.getConnectivitySummary();
      assert.deepEqual(directConnectivitySummary, {
        n_cells: 3,
        n_edges: null,
        max_neighbors: null,
      });
      assert.equal(
        Object.isFrozen(directConnectivitySummary),
        true,
        'finalized direct connectivity metadata must be immutable'
      );
      assert.equal(
        loader.connectivityCalls,
        connectivityCallsBeforeSummary,
        'connectivity summary access must not materialize or recache edges'
      );
      const edges = await adapter.getConnectivityEdges();
      assert.deepEqual(Array.from(edgeListOf(edges).sources), [0, 1]);
      assert.deepEqual(Array.from(edgeListOf(edges).destinations), [1, 2]);
      assert.deepEqual(edgeWeightsOf(edges), edgeWeightsFrom([1, 1]));
      assert.equal(edges.nCells, 3);
      assert.equal(edges.nEdges, 2);
      assert.equal(edges.maxNeighbors, 2);

      await assert.rejects(
        adapter.finalizeDirectIdentity({
          id,
          name: id,
          preferFileName: false,
          description: '',
          source: { name: 'duplicate' },
        }),
        /already finalized/
      );
    });
  }
});

test('direct dispatch requires the exact protocol and adopted dataset id', async () => {
  const manager = getDataSourceManager();
  const previous = {
    activeSource: manager.activeSource,
    activeDatasetId: manager.activeDatasetId,
    activeIdentityId: manager.activeIdentityId,
    activeDatasetMetadata: manager.activeDatasetMetadata,
  };
  const originalFetch = globalThis.fetch;
  let standardFetchCalls = 0;

  try {
    const fixtures = new Map();
    for (const format of ['h5ad', 'zarr']) {
      const id = `dispatch-${format}-a`;
      fixtures.set(format, {
        id,
        ...await createDirectSource(format, id),
      });
    }

    for (const format of ['h5ad', 'zarr']) {
      const fixture = fixtures.get(format);
      const otherFormat = format === 'h5ad' ? 'zarr' : 'h5ad';
      manager.activeSource = fixture.source;
      manager.activeDatasetId = fixture.id;
      manager.activeIdentityId = fixture.id;
      manager.activeDatasetMetadata = fixture.identity;

      const baseUrl = `${format}://${fixture.id}/`;
      assert.strictEqual(
        await loadDatasetIdentity(baseUrl),
        fixture.identity
      );
      const points = await loadPointsBinary(
        `${baseUrl}${fixture.identity.embeddings.items.X_umap_2d.path}`,
        { dimension: 2 }
      );
      assert.equal(points.positions.length, 6);

      const obsFields = await loadObsFields(
        `${baseUrl}obs`
      );
      assert.equal(obsFields.n_points, 3);
      assert.deepEqual(
        obsFields.fields.map(field => field.key),
        [
          'nullable_integer',
          'numeric_category',
          'boolean_category',
          'nullable_boolean',
          'nullable_string',
        ]
      );
      const geneList = await loadGeneList(
        `${baseUrl}var`
      );
      assert.equal(geneList.n_points, 3);
      assert.deepEqual(geneList.fields, []);

      const graphUrl = `${baseUrl}obsp`;
      const graphSummary = await loadConnectivitySummary(graphUrl);
      assert.deepEqual(graphSummary, {
        n_cells: 3,
        n_edges: null,
        max_neighbors: null,
      });
      const graph = await loadEdges(
        graphUrl,
        graphSummary,
        { signal: EDGE_SIGNAL }
      );
      assert.equal(graph.nCells, 3);
      assert.equal(graph.nEdges, 2);
      assert.equal(graph.maxNeighbors, 2);
      assert.deepEqual(edgeWeightsOf(graph), edgeWeightsFrom([1, 1]));

      const generation = await loadDatasetGeneration(baseUrl, {
        signal: new AbortController().signal,
        expectedIdentityId: fixture.identity.id,
      });
      assert.deepEqual(
        generation.identity.obs_fields.map(field => field.key),
        generation.obsFields.fields.map(field => field.key),
        `${format} direct identity and checked obs field list ` +
        'must preserve one emitted order'
      );

      await assert.rejects(
        loadDatasetIdentity(
          `${format}://${fixture.id}-other/`
        ),
        /belongs to dataset|active dataset/
      );
      await assert.rejects(
        loadDatasetIdentity(
          `${otherFormat}://${fixture.id}/`
        ),
        /active dataset protocol/
      );
    }

    await assert.rejects(
      loadDatasetIdentity('https://ordinary.example/'),
      /h5ad:\/\/ or zarr:\/\/ URL/,
      'an ordinary URL is no dataset'
    );
    assert.equal(standardFetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    manager.activeSource = previous.activeSource;
    manager.activeDatasetId = previous.activeDatasetId;
    manager.activeIdentityId = previous.activeIdentityId;
    manager.activeDatasetMetadata =
      previous.activeDatasetMetadata;
  }
});

test(
  'staged H5AD and Zarr candidates load completely while another dataset stays active',
  async t => {
    const manager = getDataSourceManager();
    const previous = {
      activeSource: manager.activeSource,
      activeDatasetId: manager.activeDatasetId,
      activeIdentityId: manager.activeIdentityId,
      activeDatasetMetadata: manager.activeDatasetMetadata,
    };
    const preparedSource = {
      datasetId: 'active-prepared',
      getType() {
        return 'local-user';
      },
      getAnnDataSource() {
        return null;
      },
    };
    const preparedMetadata = Object.freeze({
      id: 'active-prepared',
    });
    manager.activeSource = preparedSource;
    manager.activeDatasetId = preparedSource.datasetId;
    manager.activeIdentityId = 'active-prepared-identity';
    manager.activeDatasetMetadata = preparedMetadata;
    t.after(() => {
      manager.activeSource = previous.activeSource;
      manager.activeDatasetId = previous.activeDatasetId;
      manager.activeIdentityId = previous.activeIdentityId;
      manager.activeDatasetMetadata =
        previous.activeDatasetMetadata;
    });

    for (const format of ['h5ad', 'zarr']) {
      const id = `staged-${format}`;
      const fixture = {
        id,
        ...await createDirectSource(format, id),
      };
      t.after(() => fixture.source.clear());
      const candidate = createLocalAnnDataCandidate(format, fixture);
      const baseUrl = `${format}://${id}/`;
      const binding = createCandidateAnnDataBinding(
        baseUrl,
        candidate
      );
      const signal = new AbortController().signal;
      const options = {
        candidateAnnDataBinding: binding,
        signal,
      };

      const generation = await loadDatasetGeneration(baseUrl, {
        candidateAnnDataBinding: binding,
        expectedIdentityId: id,
        signal,
      });
      assert.strictEqual(generation.identity, fixture.identity);
      assert.equal(generation.obsFields.n_points, 3);
      assert.equal(generation.geneList, null);
      assert.equal(generation.connectivitySummary.n_edges, null);
      assert.equal(
        (
          await loadGeneList(
            `${baseUrl}var`,
            options
          )
        ).n_points,
        3
      );

      const points = await loadPointsBinary(
        `${baseUrl}${fixture.identity.embeddings.items.X_umap_2d.path}`,
        {
          candidateAnnDataBinding: binding,
          dimension: 2,
          signal,
        }
      );
      assert.equal(points.positions.length, 6);
      assert.equal(manager.activeSource, preparedSource);
      assert.equal(manager.activeDatasetId, 'active-prepared');
      assert.equal(
        manager.activeDatasetMetadata,
        preparedMetadata
      );

      const otherFormat = format === 'h5ad' ? 'zarr' : 'h5ad';
      assert.throws(
        () => createCandidateAnnDataBinding(
          `${otherFormat}://${id}/`,
          candidate
        ),
        /candidate.*owns|protocol|mode/i
      );
      assert.throws(
        () => createCandidateAnnDataBinding(
          `${format}://${id}-other/`,
          candidate
        ),
        /belongs to dataset|candidate source owns/i
      );
      await assert.rejects(
        loadDatasetIdentity(
          `${format}://${id}-other/`,
          options
        ),
        /binding does not own.*protocol.*dataset id/i
      );
      await assert.rejects(
        loadDatasetIdentity(
          baseUrl,
          {
            candidateAnnDataBinding: Object.freeze({
              datasetId: id,
              protocol: format,
            }),
            signal,
          }
        ),
        /must be created by createCandidateAnnDataBinding/i
      );
    }
  }
);

test('staged metadata owners reject non-data option shapes before I/O', async () => {
  let accessorReads = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'signal', {
    enumerable: true,
    get() {
      accessorReads++;
      return null;
    },
  });
  const nonEnumerable = {};
  Object.defineProperty(nonEnumerable, 'signal', {
    enumerable: false,
    value: null,
  });
  const inherited = Object.create({ signal: null });
  const symbol = { [Symbol('signal')]: null };
  const unknown = { stagedSource: null };

  for (const options of [
    accessor,
    nonEnumerable,
    inherited,
    symbol,
    unknown,
  ]) {
    await assert.rejects(
      loadDatasetIdentity(
        'h5ad://dataset/',
        options
      ),
      TypeError
    );
  }
});
