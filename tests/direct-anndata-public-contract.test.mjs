import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import {
  loadConnectivityManifest,
  loadDatasetIdentity,
  loadEdges,
  loadObsManifest,
  loadPointsBinary,
  loadVarManifest,
} from '../assets/js/data/data-loaders.js';
import {
  getDataSourceManager,
} from '../assets/js/data/data-source-manager.js';
import {
  loadDatasetGeneration,
} from '../assets/js/data/dataset-generation-contract.js';
import {
  createCandidateAnnDataBinding,
} from '../assets/js/data/anndata-provider.js';
import { H5adDataSource } from '../assets/js/data/h5ad.js';
import { ZarrDataSource } from '../assets/js/data/zarr.js';

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
  const shapeCalls = [];
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
    obsmKeys: Object.keys(embeddings),
    embeddingCalls,
    shapeCalls,
    connectivityCalls: 0,
    async getDatasetMetadata() {
      return {
        version: 2,
        name: 'private-loader-metadata',
        description: '',
        cellucid_data_version: 'private-loader',
        stats: {
          n_cells: this.nObs,
          n_genes: this.nVars,
          n_obs_fields: 0,
          n_categorical_fields: 0,
          n_continuous_fields: 0,
          has_connectivity: true,
          n_edges: null,
        },
        embeddings: {
          available_dimensions: [3, 2],
          default_dimension: 3,
          obsm_keys: {
            '3d': 'X_umap_3d',
            '2d': 'X_umap_2d',
          },
          has_expression_matrix: false,
        },
        obs_fields: [],
      };
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
    async getEmbeddingShape(key) {
      shapeCalls.push(key);
      const embedding = embeddings[key];
      if (!embedding) {
        throw new Error(`Unexpected embedding shape request "${key}"`);
      }
      return {
        nCells: this.nObs,
        nDims: embedding.nDims,
      };
    },
    async getEmbedding(key) {
      embeddingCalls.push(key);
      const embedding = embeddings[key];
      if (!embedding) {
        throw new Error(`Unexpected embedding payload request "${key}"`);
      }
      return {
        data: embedding.data.slice(),
        nDims: embedding.nDims,
      };
    },
    releaseEmbedding() {},
    async getConnectivities() {
      this.connectivityCalls++;
      return denseConnectivity();
    },
    async getGeneExpression() {
      throw new Error('X=None must not expose gene expression');
    },
    close() {},
  };
  return loader;
}

async function createDirectSource(format, id) {
  const loader = createDirectLoader();
  const adapter = new BaseAnnDataAdapter(loader);
  await adapter.initialize();

  assert.deepEqual(
    loader.embeddingCalls,
    ['X_umap_3d'],
    'initial validation materializes only the advertised maximum/default embedding'
  );
  assert.deepEqual(
    loader.shapeCalls.sort(),
    ['velocity_umap_2d', 'velocity_umap_3d'],
    'vector discovery is shape-only'
  );

  const filename = format === 'h5ad'
    ? `${id}.h5ad`
    : `${id}.zarr`;
  const identity = await adapter.finalizeDirectIdentity({
    id,
    name: id,
    description: `Direct ${format} contract fixture`,
    cellucidDataVersion: `${format}_loader`,
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
    getH5adSource() {
      return format === 'h5ad' ? fixture.source : null;
    },
    getType() {
      return 'local-user';
    },
    getZarrSource() {
      return format === 'zarr' ? fixture.source : null;
    },
    isH5adMode() {
      return format === 'h5ad';
    },
    isZarrMode() {
      return format === 'zarr';
    },
  };
}

test('H5AD and Zarr publish one exact v2 identity before direct adoption', async t => {
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
        'cellucid_data_version',
        'description',
        'embeddings',
        'id',
        'name',
        'obs_fields',
        'source',
        'stats',
        'vector_fields',
        'version',
      ]);
      assert.deepEqual(identity.embeddings, {
        available_dimensions: [2, 3],
        default_dimension: 3,
        files: {
          '2d': 'points_2d.bin',
          '3d': 'points_3d.bin',
        },
      });
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
        {
          key: 'nullable_boolean',
          kind: 'category',
          n_categories: 2,
        },
        {
          key: 'nullable_string',
          kind: 'category',
          n_categories: 2,
        },
      ]);
      assert.deepEqual(identity.stats, {
        n_cells: 3,
        n_genes: 0,
        n_obs_fields: 5,
        n_categorical_fields: 4,
        n_continuous_fields: 1,
        has_connectivity: true,
        n_edges: 2,
      });
      assert.deepEqual(identity.vector_fields, {
        default_field: 'velocity_umap',
        fields: {
          velocity_umap: {
            label: 'Velocity (UMAP)',
            basis: 'umap',
            available_dimensions: [2, 3],
            default_dimension: 3,
            files: {
              '2d': 'vectors/0_2d.bin',
              '3d': 'vectors/0_3d.bin',
            },
          },
        },
      });

      const publicIdentity = JSON.stringify(identity);
      for (const privateMember of [
        'obsm_keys',
        'has_expression_matrix',
        '_h5ad_loader',
        '_zarr_loader',
      ]) {
        assert.equal(
          publicIdentity.includes(privateMember),
          false,
          `${privateMember} must remain private`
        );
      }

      assert.equal(loader.nVars, 5);
      assert.deepEqual(
        loader.varNames,
        ['G0', 'G1', 'G2', 'G3', 'G4'],
        'X=None retains the private var axis'
      );
      assert.deepEqual(
        adapter.getVarManifest().fields,
        [],
        'X=None publishes zero expression fields'
      );
      await assert.rejects(
        adapter.getGeneExpression('G0'),
        /does not contain an X expression matrix/
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

      const connectivityCallsBeforeManifest =
        loader.connectivityCalls;
      const directConnectivityManifest =
        await source.getConnectivityManifest();
      assert.deepEqual(directConnectivityManifest, {
        format: 'edge_pairs',
        n_cells: 3,
        n_edges: 2,
        max_neighbors: 2,
        index_dtype: 'uint32',
        index_bytes: 4,
      });
      assert.equal(
        Object.isFrozen(directConnectivityManifest),
        true,
        'finalized direct connectivity metadata must be immutable'
      );
      assert.equal(
        loader.connectivityCalls,
        connectivityCallsBeforeManifest,
        'connectivity manifest access must not materialize or recache edges'
      );
      const edges = await adapter.getConnectivityEdges();
      assert.deepEqual(Array.from(edges.sources), [0, 1]);
      assert.deepEqual(Array.from(edges.destinations), [1, 2]);
      assert.deepEqual(Array.from(edges.weights), [1, 1]);
      assert.equal(edges.nCells, 3);
      assert.equal(edges.nEdges, 2);
      assert.equal(edges.maxNeighbors, 2);

      await assert.rejects(
        adapter.finalizeDirectIdentity({
          id,
          name: id,
          description: '',
          cellucidDataVersion: `${format}_loader`,
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
        await loadDatasetIdentity(`${baseUrl}dataset_identity.json`),
        fixture.identity
      );
      const points = await loadPointsBinary(
        `${baseUrl}points_2d.bin`,
        { dimension: 2, expectedBytes: 24 }
      );
      assert.equal(points.length, 6);

      const obsManifest = await loadObsManifest(
        `${baseUrl}obs_manifest.json`
      );
      assert.equal(obsManifest.n_points, 3);
      assert.deepEqual(
        obsManifest.fields.map(field => field.key),
        [
          'nullable_integer',
          'numeric_category',
          'boolean_category',
          'nullable_boolean',
          'nullable_string',
        ]
      );
      const varManifest = await loadVarManifest(
        `${baseUrl}var_manifest.json`
      );
      assert.equal(varManifest.n_points, 3);
      assert.deepEqual(varManifest.fields, []);

      const graphUrl = `${baseUrl}connectivity_manifest.json`;
      const graphManifest = await loadConnectivityManifest(graphUrl);
      assert.deepEqual(graphManifest, {
        format: 'edge_pairs',
        n_cells: 3,
        n_edges: 2,
        max_neighbors: 2,
        index_dtype: 'uint32',
        index_bytes: 4,
      });
      const graph = await loadEdges(
        graphUrl,
        graphManifest,
        { signal: EDGE_SIGNAL }
      );
      assert.equal(graph.nCells, 3);
      assert.equal(graph.nEdges, 2);
      assert.equal(graph.maxNeighbors, 2);
      assert.deepEqual(Array.from(graph.weights), [1, 1]);

      const generation = await loadDatasetGeneration({
        signal: new AbortController().signal,
        expectedIdentityId: fixture.identity.id,
        loadIdentity: () =>
          loadDatasetIdentity(
            `${baseUrl}dataset_identity.json`
          ),
        loadObsManifest: () =>
          loadObsManifest(`${baseUrl}obs_manifest.json`),
        loadVarManifest: () =>
          loadVarManifest(`${baseUrl}var_manifest.json`),
        loadConnectivityManifest: () =>
          loadConnectivityManifest(graphUrl),
      });
      assert.deepEqual(
        generation.identity.obs_fields.map(field => field.key),
        generation.obsManifest.fields.map(field => field.key),
        `${format} direct identity and expanded observation manifest ` +
        'must preserve one emitted order'
      );

      await assert.rejects(
        loadDatasetIdentity(
          `${format}://${fixture.id}-other/dataset_identity.json`
        ),
        /belongs to dataset|active dataset/
      );
      await assert.rejects(
        loadDatasetIdentity(
          `${otherFormat}://${fixture.id}/dataset_identity.json`
        ),
        /active dataset protocol/
      );
    }

    globalThis.fetch = async url => {
      standardFetchCalls++;
      assert.equal(
        String(url),
        'https://ordinary.example/dataset_identity.json'
      );
      return new Response(
        JSON.stringify({ transport: 'ordinary-fetch' }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      );
    };
    const ordinary = await loadDatasetIdentity(
      'https://ordinary.example/dataset_identity.json'
    );
    assert.deepEqual(ordinary, { transport: 'ordinary-fetch' });
    assert.equal(
      standardFetchCalls,
      1,
      'an active AnnData source must not capture an ordinary URL'
    );
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
  'staged H5AD and Zarr candidates load completely while prepared data stays active',
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
      isH5adMode() {
        return false;
      },
      isZarrMode() {
        return false;
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

      const generation = await loadDatasetGeneration({
        signal,
        expectedIdentityId: id,
        loadIdentity: generationSignal =>
          loadDatasetIdentity(
            `${baseUrl}dataset_identity.json`,
            {
              candidateAnnDataBinding: binding,
              signal: generationSignal,
            }
          ),
        loadObsManifest: generationSignal =>
          loadObsManifest(
            `${baseUrl}obs_manifest.json`,
            {
              candidateAnnDataBinding: binding,
              signal: generationSignal,
            }
          ),
        loadVarManifest: generationSignal =>
          loadVarManifest(
            `${baseUrl}var_manifest.json`,
            {
              candidateAnnDataBinding: binding,
              signal: generationSignal,
            }
          ),
        loadConnectivityManifest: generationSignal =>
          loadConnectivityManifest(
            `${baseUrl}connectivity_manifest.json`,
            {
              candidateAnnDataBinding: binding,
              signal: generationSignal,
            }
          ),
      });
      assert.strictEqual(generation.identity, fixture.identity);
      assert.equal(generation.obsManifest.n_points, 3);
      assert.equal(generation.varManifest, null);
      assert.equal(generation.connectivityManifest.n_edges, 2);
      assert.equal(
        (
          await loadVarManifest(
            `${baseUrl}var_manifest.json`,
            options
          )
        ).n_points,
        3
      );

      const points = await loadPointsBinary(
        `${baseUrl}points_2d.bin`,
        {
          candidateAnnDataBinding: binding,
          dimension: 2,
          expectedBytes: 24,
          signal,
        }
      );
      assert.equal(points.length, 6);
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
          `${format}://${id}-other/dataset_identity.json`,
          options
        ),
        /binding does not own.*protocol.*dataset id/i
      );
      await assert.rejects(
        loadDatasetIdentity(
          `${baseUrl}dataset_identity.json`,
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
  Object.defineProperty(accessor, 'stagedSource', {
    enumerable: true,
    get() {
      accessorReads++;
      return null;
    },
  });
  const nonEnumerable = {};
  Object.defineProperty(nonEnumerable, 'stagedSource', {
    enumerable: false,
    value: null,
  });
  const inherited = Object.create({ stagedSource: null });
  const symbol = { [Symbol('stagedSource')]: null };

  for (const options of [
    accessor,
    nonEnumerable,
    inherited,
    symbol,
  ]) {
    await assert.rejects(
      loadDatasetIdentity(
        'https://ordinary.test/dataset_identity.json',
        options
      ),
      TypeError
    );
  }
  assert.equal(accessorReads, 0);
});

test('progress-tracked cross-origin points use one direct streaming CORS request', () => {
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { pathToFileURL } from 'node:url';
    import { resolve } from 'node:path';

    const directRequests = [];
    let progressUpdates = 0;

    globalThis.window = {
      location: {
        href: 'https://app.example/index.html',
        origin: 'https://app.example',
        search: '',
      },
    };
    globalThis.document = {
      querySelectorAll() {
        return [];
      },
    };
    globalThis.fetch = async (url, init) => {
      directRequests.push({ url, init });
      const bytes = new Uint8Array(
        Float32Array.from([1, 2, 3, 4]).buffer
      );
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 8));
          controller.enqueue(bytes.slice(8));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: {
          'content-length': String(bytes.byteLength),
          'content-type': 'application/octet-stream',
        },
      });
    };

    const moduleUrl = relativePath =>
      pathToFileURL(resolve(process.cwd(), relativePath)).href;
    const dataSource = await import(
      moduleUrl('assets/js/data/data-source.js')
    );
    dataSource.DATA_CONFIG.EXPORTS_BASE_URL =
      'https://datasets.example/exports/';

    const notificationModule = await import(
      moduleUrl('assets/js/app/notification-center.js')
    );
    const notifications =
      notificationModule.getNotificationCenter();
    notifications.startDownload = () => 'points-tracker';
    notifications.updateDownload = () => {
      progressUpdates++;
    };
    notifications.completeDownload = () => {};
    notifications.failDownload = () => {};
    notifications.dismissDownload = () => {};

    const loaders = await import(
      moduleUrl('assets/js/data/data-loaders.js')
    );
    const values = await loaders.loadPointsBinary(
      'https://datasets.example/exports/demo/points_2d.bin',
      {
        dimension: 2,
        expectedBytes: 16,
        showProgress: true,
      }
    );

    assert.deepEqual(Array.from(values), [1, 2, 3, 4]);
    assert.equal(directRequests.length, 1);
    assert.equal(
      directRequests[0].url,
      'https://datasets.example/exports/demo/points_2d.bin'
    );
    assert.equal(directRequests[0].init.method, 'GET');
    assert.equal(directRequests[0].init.cache, 'default');
    assert.deepEqual(directRequests[0].init.headers, []);
    assert.equal(directRequests[0].init.mode, 'cors');
    assert.equal(directRequests[0].init.credentials, 'omit');
    assert.equal(directRequests[0].init.redirect, 'error');
    assert.ok(progressUpdates > 0);
  `;

  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 20_000,
    }
  );
  assert.equal(
    result.status,
    0,
    `direct-CORS child failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
});
