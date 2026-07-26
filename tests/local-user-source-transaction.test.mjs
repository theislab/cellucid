import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  H5adDataSource
} from '../assets/js/data/h5ad.js';
import {
  validateDatasetIdentity
} from '../assets/js/data/data-source.js';
import {
  LocalUserDirDataSource
} from '../assets/js/data/local-user-source.js';
import {
  createDataSourceManager,
  getDataSourceManager,
} from '../assets/js/data/data-source-manager.js';
import {
  loadConnectivityManifest,
  loadEdges,
  loadObsFieldData,
  loadObsManifest,
  loadVarFieldData,
  loadVarManifest,
} from '../assets/js/data/data-loaders.js';
import {
  ZarrDataSource
} from '../assets/js/data/zarr.js';

const PREPARED_CREATED_AT = '2026-01-02T03:04:05Z';

function createPreparedExportSettings(overrides = {}) {
  return {
    compression: null,
    var_quantization: null,
    obs_continuous_quantization: null,
    obs_categorical_dtype: 'uint16',
    ...overrides,
  };
}

function createFile(path, contents = '') {
  const normalizedPath = path.replace(/\\/g, '/');
  const name = normalizedPath.split('/').at(-1);
  const file = new Blob([contents]);
  Object.defineProperties(file, {
    name: {
      configurable: true,
      value: name
    },
    webkitRelativePath: {
      configurable: true,
      value: normalizedPath
    }
  });
  return file;
}

function createPreparedDirectory(
  directoryName,
  {
    displayName = directoryName,
    extraFiles = [],
    identityPayload = null,
    nCells = 2,
    identityText = null,
    obsText = null,
    pointsContents = null,
    pointsFilename = 'points_2d.bin',
  } = {}
) {
  const identity = JSON.stringify(identityPayload ?? {
      version: 2,
      id: directoryName,
      name: displayName,
      description: `Prepared fixture ${displayName}`,
      created_at: PREPARED_CREATED_AT,
      cellucid_data_version: 'test-current',
      stats: {
        n_cells: nCells,
        n_genes: 0,
        n_obs_fields: 0,
        n_categorical_fields: 0,
        n_continuous_fields: 0,
        has_connectivity: false,
        n_edges: null,
      },
      embeddings: {
        available_dimensions: [2],
        default_dimension: 2,
        files: { '2d': pointsFilename },
      },
      obs_fields: [],
      export_settings: createPreparedExportSettings(),
    });
  const identityFile = createFile(
    `${directoryName}/dataset_identity.json`,
    identity
  );
  if (identityText) {
    Object.defineProperty(identityFile, 'text', {
      configurable: true,
      value: identityText
    });
  }

  return [
    identityFile,
    createFile(
      `${directoryName}/obs_manifest.json`,
      obsText ?? JSON.stringify({
        _format: 'compact_v1',
        n_points: nCells,
        centroid_outlier_quantile: null,
        latent_key: null,
        compression: null,
        _obsSchemas: {},
        _continuousFields: [],
        _categoricalFields: [],
      })
    ),
    createFile(
      `${directoryName}/${pointsFilename}`,
      pointsContents ??
        new Uint8Array(nCells * 2 * Float32Array.BYTES_PER_ELEMENT)
    ),
    ...extraFiles.map(([path, contents]) => createFile(
      `${directoryName}/${path}`,
      contents
    ))
  ];
}

function createPreparedIdentity({
  id = 'candidate-dataset',
  nCells = 2,
  pointsFilename = 'points_2d.bin',
  stats = {},
  exportSettings = {},
  ...extra
} = {}) {
  return {
    version: 2,
    id,
    name: 'Candidate dataset',
    description: 'Prepared fixture candidate',
    created_at: PREPARED_CREATED_AT,
    cellucid_data_version: 'test-current',
    stats: {
      n_cells: nCells,
      n_genes: 0,
      n_obs_fields: 0,
      n_categorical_fields: 0,
      n_continuous_fields: 0,
      has_connectivity: false,
      n_edges: null,
      ...stats,
    },
    embeddings: {
      available_dimensions: [2],
      default_dimension: 2,
      files: { '2d': pointsFilename },
    },
    obs_fields: [],
    export_settings: createPreparedExportSettings(exportSettings),
    ...extra,
  };
}

function float32Bytes(values) {
  const bytes = new Uint8Array(values.length * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, value, true);
  });
  return bytes;
}

function float64Bytes(values) {
  const bytes = new Uint8Array(values.length * Float64Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    view.setFloat64(index * Float64Array.BYTES_PER_ELEMENT, value, true);
  });
  return bytes;
}

function uint16Bytes(values) {
  const bytes = new Uint8Array(values.length * Uint16Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    view.setUint16(index * Uint16Array.BYTES_PER_ELEMENT, value, true);
  });
  return bytes;
}

function createRichCompactPreparedDirectory(directoryName = 'rich-compact') {
  const nCells = 3;
  const identityPayload = createPreparedIdentity({
    id: directoryName,
    nCells,
    stats: {
      n_genes: 2,
      n_obs_fields: 2,
      n_categorical_fields: 1,
      n_continuous_fields: 1,
      has_connectivity: true,
      n_edges: 2,
    },
    obs_fields: [
      { key: 'score', kind: 'continuous' },
      { key: 'cluster', kind: 'category', n_categories: 2 },
    ],
    exportSettings: {
      obs_categorical_dtype: 'uint8',
    },
    vector_fields: {
      default_field: 'velocity_umap',
      fields: {
        velocity_umap: {
          label: 'velocity_umap',
          available_dimensions: [2],
          default_dimension: 2,
          files: { '2d': 'vectors/velocity_umap_2d.bin' },
          basis: 'umap',
        },
      },
    },
  });
  const obsManifest = {
    _format: 'compact_v1',
    n_points: nCells,
    centroid_outlier_quantile: 0.95,
    latent_key: null,
    compression: null,
    _obsSchemas: {
      continuous: {
        pathPattern: 'obs/{key}.values.f32',
        ext: 'f32',
        dtype: 'float32',
        quantized: false,
      },
      categorical: {
        codesPathPattern: 'obs/{key}.codes.{ext}',
        outlierPathPattern: 'obs/{key}.outliers.f32',
        outlierExt: 'f32',
        outlierDtype: 'float32',
        outlierQuantized: false,
      },
    },
    _continuousFields: [['score']],
    _categoricalFields: [[
      'cluster',
      ['A', 'B'],
      'uint8',
      255,
      { '2': [] },
    ]],
  };
  const varManifest = {
    _format: 'compact_v1',
    n_points: nCells,
    var_gene_id_column: null,
    compression: null,
    quantization: null,
    _varSchema: {
      kind: 'continuous',
      pathPattern: 'var/{key}.values.f32',
      ext: 'f32',
      dtype: 'float32',
      quantized: false,
    },
    fields: [['Gene A'], ['Gene/B']],
  };
  const connectivityManifest = {
    format: 'edge_pairs',
    n_cells: nCells,
    n_edges: 2,
    max_neighbors: 2,
    index_bytes: 2,
    index_dtype: 'uint16',
    sourcesPath: 'connectivity/edges.src.bin',
    destinationsPath: 'connectivity/edges.dst.bin',
    weightsPath: 'connectivity/edges.weights.f64.bin',
    weight_bytes: 8,
    weight_dtype: 'float64',
    compression: null,
  };

  return createPreparedDirectory(directoryName, {
    nCells,
    identityPayload,
    obsText: JSON.stringify(obsManifest),
    pointsContents: float32Bytes([0, 0, 1, 0, 0, 1]),
    extraFiles: [
      ['obs/score.values.f32', float32Bytes([0.25, 0.5, 0.75])],
      ['obs/cluster.codes.u8', new Uint8Array([0, 1, 255])],
      ['obs/cluster.outliers.f32', float32Bytes([0.1, 0.2, 0.3])],
      ['var_manifest.json', JSON.stringify(varManifest)],
      ['var/Gene_A.values.f32', float32Bytes([1, 2, 3])],
      ['var/Gene_B.values.f32', float32Bytes([4, 5, 6])],
      ['connectivity_manifest.json', JSON.stringify(connectivityManifest)],
      ['connectivity/edges.src.bin', uint16Bytes([0, 1])],
      ['connectivity/edges.dst.bin', uint16Bytes([1, 2])],
      ['connectivity/edges.weights.f64.bin', float64Bytes([0.25, 2])],
      [
        'vectors/velocity_umap_2d.bin',
        float32Bytes([0.1, 0, 0.2, 0, 0.3, 0]),
      ],
    ],
  });
}

function createConnectivityPreparedDirectory(
  directoryName,
  {
    nCells = 3,
    sources = [0, 1],
    destinations = [1, 2],
    weights = new Array(sources.length).fill(1),
    maxNeighbors = 2,
    manifest = null,
    exportSettings = {},
  } = {}
) {
  const connectivityManifest = manifest ?? {
    format: 'edge_pairs',
    n_cells: nCells,
    n_edges: sources.length,
    max_neighbors: maxNeighbors,
    index_bytes: 2,
    index_dtype: 'uint16',
    sourcesPath: 'connectivity/edges.src.bin',
    destinationsPath: 'connectivity/edges.dst.bin',
    weightsPath: 'connectivity/edges.weights.f64.bin',
    weight_bytes: 8,
    weight_dtype: 'float64',
    compression: null,
  };
  return createPreparedDirectory(directoryName, {
    nCells,
    identityPayload: createPreparedIdentity({
      id: directoryName,
      nCells,
      stats: {
        has_connectivity: true,
        n_edges: sources.length,
      },
      exportSettings,
    }),
    extraFiles: [
      [
        'connectivity_manifest.json',
        JSON.stringify(connectivityManifest),
      ],
      [
        connectivityManifest.sourcesPath,
        uint16Bytes(sources),
      ],
      [
        connectivityManifest.destinationsPath,
        uint16Bytes(destinations),
      ],
      ...(
        typeof connectivityManifest.weightsPath === 'string'
          ? [[connectivityManifest.weightsPath, float64Bytes(weights)]]
          : []
      ),
    ],
  });
}

function createLargePreparedGeneDirectory(
  directoryName,
  {
    gzipAll = false,
    nGenes = 257,
    payloadForIndex = null,
  } = {}
) {
  const fields = [];
  const extraFiles = [];
  for (let index = 0; index < nGenes; index++) {
    const key = `Gene_${String(index).padStart(4, '0')}`;
    const defaultPath =
      `var/${key}.values.f32${gzipAll ? '.gz' : ''}`;
    const payload = payloadForIndex?.({
      index,
      key,
      defaultPath,
    }) ?? {};
    fields.push([key]);
    if (payload.omit !== true) {
      const defaultContents = float32Bytes([index, index + 1]);
      extraFiles.push([
        defaultPath,
        Object.hasOwn(payload, 'contents')
          ? payload.contents
          : (gzipAll ? gzipSync(defaultContents) : defaultContents),
      ]);
    }
  }
  extraFiles.unshift([
    'var_manifest.json',
    JSON.stringify({
      _format: 'compact_v1',
      n_points: 2,
      var_gene_id_column: null,
      compression: gzipAll ? 6 : null,
      quantization: null,
      _varSchema: {
        kind: 'continuous',
        pathPattern:
          `var/{key}.values.f32${gzipAll ? '.gz' : ''}`,
        ext: 'f32',
        dtype: 'float32',
        quantized: false,
      },
      fields,
    }),
  ]);
  return createPreparedDirectory(directoryName, {
    identityPayload: createPreparedIdentity({
      pointsFilename: gzipAll
        ? 'points_2d.bin.gz'
        : 'points_2d.bin',
      stats: { n_genes: nGenes },
      exportSettings: {
        compression: gzipAll ? 6 : null,
      },
    }),
    pointsFilename: gzipAll
      ? 'points_2d.bin.gz'
      : 'points_2d.bin',
    pointsContents: gzipAll
      ? gzipSync(
          new Uint8Array(2 * 2 * Float32Array.BYTES_PER_ELEMENT)
        )
      : null,
    obsText: gzipAll
      ? JSON.stringify({
          _format: 'compact_v1',
          n_points: 2,
          centroid_outlier_quantile: null,
          latent_key: null,
          compression: 6,
          _obsSchemas: {},
          _continuousFields: [],
          _categoricalFields: [],
        })
      : null,
    extraFiles,
  });
}

function spoofGzipSize(contents, declaredBytes) {
  const compressed = new Uint8Array(gzipSync(contents));
  new DataView(
    compressed.buffer,
    compressed.byteOffset,
    compressed.byteLength
  ).setUint32(compressed.byteLength - 4, declaredBytes, true);
  return compressed;
}

function corruptGzipCrc(contents) {
  const compressed = new Uint8Array(gzipSync(contents));
  compressed[compressed.byteLength - 8] ^= 0xff;
  return compressed;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function isExplicitSupersession(error) {
  return (
    error?.name === 'AbortError' ||
    /supersed|replac|newer selection|cancel|abort/i.test(error?.message || '')
  );
}

async function loadWorkingPreparedSource(t) {
  const source = new LocalUserDirDataSource();
  t.after(() => source.clear());

  const metadata = await source.loadFromPreparedDirectory(
    createPreparedDirectory('working', {
      displayName: 'Working dataset',
      nCells: 3
    })
  );

  return {
    source,
    datasetId: source.datasetId,
    metadata: structuredClone(metadata)
  };
}

async function assertWorkingPreparedSource({
  source,
  datasetId,
  metadata
}) {
  assert.equal(await source.isAvailable(), true);
  assert.equal(source.datasetId, datasetId);
  assert.equal(source.getPath(), 'working');
  assert.equal(
    source.getBaseUrl(datasetId),
    `local-user://dataset/${encodeURIComponent(datasetId)}/`
  );
  assert.deepEqual(await source.getMetadata(datasetId), metadata);
  assert.deepEqual(await source.listDatasets(), [metadata]);

  const identityUrl = await source.resolveUrl(
    `${source.getBaseUrl(datasetId)}dataset_identity.json`,
    null
  );
  const identity = await (await fetch(identityUrl)).json();
  assert.equal(identity.name, 'Working dataset');
}

test('local selections expose a monotonic identity before asynchronous work', async () => {
  const source = new LocalUserDirDataSource();
  const identityRead = deferred();
  const initialIdentity = source.getSelectionIdentity();
  const loading = source.loadFromPreparedDirectory(
    createPreparedDirectory('delayed', {
      identityText: () => identityRead.promise
    })
  );
  const loadingIdentity = source.getSelectionIdentity();

  assert.ok(loadingIdentity > initialIdentity);
  source.clear();
  assert.ok(source.getSelectionIdentity() > loadingIdentity);
  identityRead.resolve(JSON.stringify({
    version: 2,
    name: 'Delayed dataset',
    stats: { n_cells: 2 }
  }));
  await assert.rejects(loading, isExplicitSupersession);
});

test('local adoption identity changes only when working source state changes', async () => {
  const source = new LocalUserDirDataSource();
  const initialIdentity = source.getAdoptionIdentity();

  await source.loadFromPreparedDirectory(
    createPreparedDirectory('working')
  );
  const workingIdentity = source.getAdoptionIdentity();
  assert.ok(workingIdentity > initialIdentity);

  await assert.rejects(
    source.loadFromPreparedDirectory([
      createFile('broken/obs_manifest.json', '{}')
    ]),
    /missing required files/i
  );
  assert.equal(
    source.getAdoptionIdentity(),
    workingIdentity,
    'a rejected candidate must not invalidate work for the retained source'
  );

  source.clear();
  assert.ok(source.getAdoptionIdentity() > workingIdentity);
});

test('prepared adoption requires the sole exact dataset identity before mutation', async t => {
  const cases = [
    [
      'missing prepared identity id',
      identity => {
        delete identity.id;
      },
      /dataset_identity\.json.*id.*required|dataset identity.*id/i,
    ],
    [
      'missing description',
      identity => {
        delete identity.description;
      },
      /description.*required|missing required field.*description/i,
    ],
    [
      'non-portable identity id',
      identity => {
        identity.id = '../same dataset';
      },
      /id.*portable identifier/i,
    ],
    [
      'missing cellucid data version',
      identity => {
        delete identity.cellucid_data_version;
      },
      /cellucid_data_version.*required|missing required field.*cellucid_data_version/i,
    ],
    [
      'string dimensions',
      identity => {
        identity.embeddings.available_dimensions = ['2'];
        identity.embeddings.default_dimension = '2';
      },
      /available_dimensions.*integer|dimension/i,
    ],
    [
      'duplicate dimensions',
      identity => {
        identity.embeddings.available_dimensions = [2, 2];
      },
      /available_dimensions.*unique|dimension/i,
    ],
    [
      'unadvertised embedding path',
      identity => {
        identity.embeddings.files['3d'] = 'points_3d.bin';
      },
      /embeddings\.files.*exact|unadvertised.*dimension/i,
    ],
    [
      'internal adapter marker',
      identity => {
        identity._anndata_adapter = true;
      },
      /unsupported field.*_anndata_adapter|extra.*_anndata_adapter/i,
    ],
  ];

  for (const [name, mutate, expected] of cases) {
    await t.test(name, async t => {
      const working = await loadWorkingPreparedSource(t);
      const adoptionIdentity = working.source.getAdoptionIdentity();
      const identity = createPreparedIdentity();
      mutate(identity);

      await assert.rejects(
        working.source.loadFromPreparedDirectory(
          createPreparedDirectory(`invalid-${name.replaceAll(' ', '-')}`, {
            identityPayload: identity,
          })
        ),
        expected
      );
      assert.equal(
        working.source.getAdoptionIdentity(),
        adoptionIdentity,
        'invalid identity must not advance the retained source'
      );
      await assertWorkingPreparedSource(working);
    });
  }
});

test('prepared source identity is invariant to FileList enumeration order', async t => {
  const source = new LocalUserDirDataSource();
  t.after(() => source.clear());
  const files = createPreparedDirectory('portable-order', {
    displayName: 'Portable order',
  });

  await source.loadFromPreparedDirectory(files);
  const forwardId = source.datasetId;
  await source.loadFromPreparedDirectory([...files].reverse());

  assert.equal(
    forwardId,
    'local-user:portable-order',
    'prepared application identity must be namespaced from demo datasets'
  );
  assert.equal(
    source.datasetId,
    forwardId,
    'one folder must retain one identity across browser enumeration orders'
  );
});

test('prepared loading has one explicit public entry point', async () => {
  const source = new LocalUserDirDataSource();
  assert.equal(typeof source.loadFromPreparedDirectory, 'function');
  assert.equal(
    Object.hasOwn(
      LocalUserDirDataSource.prototype,
      'loadFromFileList'
    ),
    false,
    'the generic format auto-router is not part of the current API'
  );
});

test('valid rich compact_v1 prepared exports retain their full contract', async t => {
  const source = new LocalUserDirDataSource();
  t.after(() => source.clear());

  const metadata = await source.loadFromPreparedDirectory(
    createRichCompactPreparedDirectory()
  );

  assert.deepEqual(metadata.stats, {
    n_cells: 3,
    n_genes: 2,
    n_obs_fields: 2,
    n_categorical_fields: 1,
    n_continuous_fields: 1,
    has_connectivity: true,
    n_edges: 2,
  });
  assert.deepEqual(
    metadata.obs_fields.map(({ key, kind, n_categories }) => ({
      key,
      kind,
      n_categories,
    })),
    [
      { key: 'score', kind: 'continuous', n_categories: undefined },
      { key: 'cluster', kind: 'category', n_categories: 2 },
    ]
  );
  assert.equal(
    metadata.vector_fields.default_field,
    'velocity_umap'
  );
  assert.equal(
    metadata.vector_fields.fields.velocity_umap.label,
    'velocity_umap'
  );
  assert.match(
    await source.resolveUrl(
      `${source.getBaseUrl(source.datasetId)}var/Gene_A.values.f32`,
      null
    ),
    /^blob:/
  );
});

test('prepared lazy payloads stay file-backed across repeated dataset adoption', async t => {
  const manager = getDataSourceManager();
  const previousLocalSource = manager.getSource('local-user');
  const source = new LocalUserDirDataSource();
  manager.registerSource('local-user', source);
  t.after(() => {
    source.clear();
    if (previousLocalSource === null) {
      manager.unregisterSource('local-user');
    } else {
      manager.registerSource('local-user', previousLocalSource);
    }
  });

  const adoptedBaseUrls = [];
  for (const directoryName of ['prepared-routing-first', 'prepared-routing-second']) {
    await source.loadFromPreparedDirectory(
      createRichCompactPreparedDirectory(directoryName)
    );

    const baseUrl = source.getBaseUrl(source.datasetId);
    adoptedBaseUrls.push(baseUrl);
    assert.equal(
      baseUrl,
      `local-user://dataset/${encodeURIComponent(source.datasetId)}/`
    );

    const obsManifestUrl = `${baseUrl}obs_manifest.json`;
    const obsManifest = await loadObsManifest(obsManifestUrl);
    const continuousField = obsManifest.fields.find(
      field => field.key === 'score'
    );
    const categoricalField = obsManifest.fields.find(
      field => field.key === 'cluster'
    );
    assert.deepEqual(
      Array.from(
        (await loadObsFieldData(obsManifestUrl, continuousField)).values
      ),
      [0.25, 0.5, 0.75]
    );
    const categorical = await loadObsFieldData(
      obsManifestUrl,
      categoricalField
    );
    assert.deepEqual(Array.from(categorical.codes), [0, 1, 65_535]);
    assert.deepEqual(
      Array.from(categorical.outlierQuantiles),
      [
        Math.fround(0.1),
        Math.fround(0.2),
        Math.fround(0.3),
      ]
    );

    const varManifestUrl = `${baseUrl}var_manifest.json`;
    const varManifest = await loadVarManifest(varManifestUrl);
    const geneField = varManifest.fields.find(
      field => field.key === 'Gene A'
    );
    assert.deepEqual(
      Array.from(
        (await loadVarFieldData(varManifestUrl, geneField)).values
      ),
      [1, 2, 3]
    );

    const connectivityManifestUrl =
      `${baseUrl}connectivity_manifest.json`;
    const connectivityManifest = await loadConnectivityManifest(
      connectivityManifestUrl
    );
    const edges = await loadEdges(
      connectivityManifestUrl,
      connectivityManifest,
      { signal: new AbortController().signal }
    );
    assert.deepEqual(Array.from(edges.sources), [0, 1]);
    assert.deepEqual(Array.from(edges.destinations), [1, 2]);
    assert.deepEqual(Array.from(edges.weights), [0.25, 2]);
  }

  assert.notEqual(adoptedBaseUrls[0], adoptedBaseUrls[1]);
  await assert.rejects(
    manager.resolveUrl(
      `${adoptedBaseUrls[0]}obs/cluster.codes.u8`,
      null
    ),
    /dataset|current|prepared-routing-first/i
  );
});

test('prepared vector metadata has one exact current shape', async t => {
  const cases = [
    [
      'missing label',
      field => {
        delete field.label;
      },
    ],
    [
      'string dimension',
      field => {
        field.available_dimensions = ['2'];
        field.default_dimension = '2';
      },
    ],
    [
      'component aliases',
      field => {
        field.components = { '2d': 2 };
      },
    ],
    [
      'unadvertised file',
      field => {
        field.files['3d'] = 'vectors/velocity_umap_3d.bin';
      },
    ],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async t => {
      const working = await loadWorkingPreparedSource(t);
      const adoptionIdentity = working.source.getAdoptionIdentity();
      const identity = createPreparedIdentity({
        vector_fields: {
          default_field: 'velocity_umap',
          fields: {
            velocity_umap: {
              label: 'velocity_umap',
              available_dimensions: [2],
              default_dimension: 2,
              files: {
                '2d': 'vectors/velocity_umap_2d.bin',
              },
              basis: 'umap',
            },
          },
        },
      });
      mutate(identity.vector_fields.fields.velocity_umap);

      await assert.rejects(
        working.source.loadFromPreparedDirectory(
          createPreparedDirectory(`invalid-vector-${name}`, {
            identityPayload: identity,
            extraFiles: [[
              'vectors/velocity_umap_2d.bin',
              float32Bytes([0, 0, 0, 0]),
            ]],
          })
        ),
        /vector field|vector_fields|dimension/i
      );
      assert.equal(
        working.source.getAdoptionIdentity(),
        adoptionIdentity
      );
      await assertWorkingPreparedSource(working);
    });
  }
});

test('prepared identity requires exact producer export metadata', async t => {
  const cases = [
    [
      'missing created_at',
      identity => {
        delete identity.created_at;
      },
    ],
    [
      'missing export_settings',
      identity => {
        delete identity.export_settings;
      },
    ],
    [
      'extra export setting',
      identity => {
        identity.export_settings.codec = 'gzip';
      },
    ],
    [
      'invalid compression level',
      identity => {
        identity.export_settings.compression = 0;
      },
    ],
    [
      'invalid var quantization',
      identity => {
        identity.export_settings.var_quantization = 12;
      },
    ],
    [
      'invalid observation quantization',
      identity => {
        identity.export_settings.obs_continuous_quantization = false;
      },
    ],
    [
      'invalid categorical dtype',
      identity => {
        identity.export_settings.obs_categorical_dtype = 'u8';
      },
    ],
    [
      'retired automatic categorical dtype',
      identity => {
        identity.export_settings.obs_categorical_dtype = 'auto';
      },
    ],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async t => {
      const working = await loadWorkingPreparedSource(t);
      const adoptionIdentity = working.source.getAdoptionIdentity();
      const identity = createPreparedIdentity({
        id: `invalid-export-${name.replaceAll(' ', '-')}`,
      });
      mutate(identity);
      await assert.rejects(
        working.source.loadFromPreparedDirectory(
          createPreparedDirectory(identity.id, {
            identityPayload: identity,
          })
        ),
        /created_at|export_settings|compression|quantization|categorical dtype/i
      );
      assert.equal(
        working.source.getAdoptionIdentity(),
        adoptionIdentity
      );
      await assertWorkingPreparedSource(working);
    });
  }
});

test('prepared export compression must agree across identity and manifests', async t => {
  const working = await loadWorkingPreparedSource(t);
  const adoptionIdentity = working.source.getAdoptionIdentity();
  const identity = createPreparedIdentity({
    id: 'compression-contradiction',
    exportSettings: { compression: 6 },
  });

  await assert.rejects(
    working.source.loadFromPreparedDirectory(
      createPreparedDirectory('compression-contradiction', {
        identityPayload: identity,
      })
    ),
    /compression|\\.gz|obs_manifest|embedding/i
  );
  assert.equal(
    working.source.getAdoptionIdentity(),
    adoptionIdentity
  );
  await assertWorkingPreparedSource(working);
});

test('prepared connectivity requires the exact canonical graph contract', async t => {
  const incompleteManifest = {
    format: 'edge_pairs',
    n_cells: 3,
    n_edges: 2,
    index_dtype: 'uint16',
    sourcesPath: 'connectivity/edges.src.bin',
    destinationsPath: 'connectivity/edges.dst.bin',
  };
  const compressedRawManifest = {
    format: 'edge_pairs',
    n_cells: 3,
    n_edges: 2,
    max_neighbors: 2,
    index_bytes: 2,
    index_dtype: 'uint16',
    sourcesPath: 'connectivity/edges.src.bin',
    destinationsPath: 'connectivity/edges.dst.bin',
    weightsPath: 'connectivity/edges.weights.f64.bin',
    weight_bytes: 8,
    weight_dtype: 'float64',
    compression: 6,
  };
  const cases = [
    {
      name: 'incomplete manifest',
      directory: createConnectivityPreparedDirectory(
        'incomplete-connectivity',
        { manifest: incompleteManifest }
      ),
    },
    {
      name: 'compression and suffix contradiction',
      directory: createConnectivityPreparedDirectory(
        'compressed-raw-connectivity',
        { manifest: compressedRawManifest }
      ),
    },
    {
      name: 'self edge',
      directory: createConnectivityPreparedDirectory(
        'self-connectivity',
        { sources: [0, 1], destinations: [0, 2] }
      ),
    },
    {
      name: 'reversed edge',
      directory: createConnectivityPreparedDirectory(
        'reversed-connectivity',
        { sources: [1, 1], destinations: [0, 2] }
      ),
    },
    {
      name: 'duplicate edge',
      directory: createConnectivityPreparedDirectory(
        'duplicate-connectivity',
        { sources: [0, 0], destinations: [1, 1] }
      ),
    },
    {
      name: 'unsorted edges',
      directory: createConnectivityPreparedDirectory(
        'unsorted-connectivity',
        { sources: [1, 0], destinations: [2, 1] }
      ),
    },
    {
      name: 'false maximum degree',
      directory: createConnectivityPreparedDirectory(
        'false-degree-connectivity',
        { maxNeighbors: 1 }
      ),
    },
    {
      name: 'short weight payload',
      directory: createConnectivityPreparedDirectory(
        'short-weight-connectivity',
        { weights: [1] }
      ),
    },
    {
      name: 'zero weight',
      directory: createConnectivityPreparedDirectory(
        'zero-weight-connectivity',
        { weights: [1, 0] }
      ),
    },
    {
      name: 'negative weight',
      directory: createConnectivityPreparedDirectory(
        'negative-weight-connectivity',
        { weights: [1, -2] }
      ),
    },
    {
      name: 'non-finite weight',
      directory: createConnectivityPreparedDirectory(
        'nonfinite-weight-connectivity',
        { weights: [1, Number.NaN] }
      ),
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async t => {
      const working = await loadWorkingPreparedSource(t);
      const adoptionIdentity = working.source.getAdoptionIdentity();
      await assert.rejects(
        working.source.loadFromPreparedDirectory(fixture.directory),
        /connectivity|max_neighbors|edge|compression|current contract/i
      );
      assert.equal(
        working.source.getAdoptionIdentity(),
        adoptionIdentity
      );
      await assertWorkingPreparedSource(working);
    });
  }
});

test('prepared uint16 connectivity adopts the exact 65,536-cell boundary', async t => {
  const source = new LocalUserDirDataSource();
  t.after(() => source.clear());

  const metadata = await source.loadFromPreparedDirectory(
    createConnectivityPreparedDirectory('uint16-cell-boundary', {
      nCells: 65_536,
      sources: [0],
      destinations: [65_535],
      weights: [0.25],
      maxNeighbors: 1,
    })
  );

  assert.equal(metadata.stats.n_cells, 65_536);
  assert.equal(metadata.stats.has_connectivity, true);
  assert.equal(metadata.stats.n_edges, 1);

  const manifestUrl = await source.resolveUrl(
    `${source.getBaseUrl(source.datasetId)}connectivity_manifest.json`,
    null
  );
  assert.deepEqual(await (await fetch(manifestUrl)).json(), {
    format: 'edge_pairs',
    n_cells: 65_536,
    n_edges: 1,
    max_neighbors: 1,
    index_bytes: 2,
    index_dtype: 'uint16',
    sourcesPath: 'connectivity/edges.src.bin',
    destinationsPath: 'connectivity/edges.dst.bin',
    weightsPath: 'connectivity/edges.weights.f64.bin',
    weight_bytes: 8,
    weight_dtype: 'float64',
    compression: null,
  });
});

test('prepared local URLs cannot cross dataset adoption generations', async t => {
  const source = new LocalUserDirDataSource();
  t.after(() => source.clear());

  await source.loadFromPreparedDirectory(
    createPreparedDirectory('old-generation')
  );
  const staleUrl =
    `${source.getBaseUrl(source.datasetId)}dataset_identity.json`;

  await source.loadFromPreparedDirectory(
    createPreparedDirectory('new-generation')
  );

  await assert.rejects(
    source.resolveUrl(staleUrl, null),
    /dataset|generation|current|old-generation/i
  );
  const currentUrl =
    `${source.getBaseUrl(source.datasetId)}dataset_identity.json`;
  const currentIdentity = await (
    await fetch(await source.resolveUrl(currentUrl, null))
  ).json();
  assert.equal(currentIdentity.id, 'new-generation');
});

test('prepared metadata and base URLs require the exact adopted dataset id', async t => {
  const source = new LocalUserDirDataSource();
  t.after(() => source.clear());
  await source.loadFromPreparedDirectory(
    createPreparedDirectory('exact-id')
  );

  await assert.rejects(
    source.getMetadata(),
    /dataset.*id|required|current/i
  );
  await assert.rejects(
    source.getMetadata('local-user:stale-id'),
    /not found|current|stale-id/i
  );
  assert.throws(
    () => source.getBaseUrl('local-user:stale-id'),
    /not found|current|stale-id/i
  );
  assert.equal(
    source.getBaseUrl(source.datasetId),
    `local-user://dataset/${encodeURIComponent(source.datasetId)}/`
  );
  await assert.rejects(
    source.resolveUrl(
      'local-user://local-user:exact-id/dataset_identity.json',
      null
    ),
    /invalid local-user URL format/i
  );
  await assert.rejects(
    source.resolveUrl(
      'local-user://dataset/local-user%3aexact-id/dataset_identity.json',
      null
    ),
    /invalid local-user URL format/i
  );
  assert.equal(source.datasetId, 'local-user:exact-id');
  assert.equal(source.getIdentityId(source.datasetId), 'exact-id');
  assert.throws(
    () => source.getIdentityId('local-user:stale-id'),
    /exact adopted dataset identity id/i
  );

  const manager = createDataSourceManager();
  manager.registerSource('local-user', source);
  const datasetEvents = [];
  manager.onDatasetChange(event => datasetEvents.push(event));
  await manager.switchToDataset('local-user', source.datasetId, {
    loadMethod: 'local-user-prepared',
  });
  assert.equal(manager.getCurrentDatasetId(), 'local-user:exact-id');
  assert.equal(manager.getCurrentIdentityId(), 'exact-id');
  assert.equal(datasetEvents.length, 1);
  assert.equal(datasetEvents[0].previousDatasetId, null);
  assert.equal(datasetEvents[0].previousSourceType, null);
  assert.equal(datasetEvents[0].sourceType, 'local-user');
  manager.clearActiveDataset({ loadMethod: 'dataset-dropdown' });
  assert.equal(manager.getCurrentIdentityId(), null);
  assert.equal(datasetEvents.length, 2);
  assert.equal(datasetEvents[1].previousDatasetId, 'local-user:exact-id');
  assert.equal(datasetEvents[1].previousSourceType, 'local-user');
  assert.equal(datasetEvents[1].sourceType, null);
});

test('prepared vector identity matches the exact producer output', async t => {
  const cases = [
    [
      'missing default field',
      metadata => {
        metadata.default_field = null;
      },
    ],
    [
      'nonportable field id',
      metadata => {
        metadata.default_field = 'bad field';
        metadata.fields['bad field'] = {
          ...metadata.fields.velocity_umap,
          files: { '2d': 'vectors/bad field_2d.bin' },
        };
        delete metadata.fields.velocity_umap;
      },
    ],
    [
      'nondeterministic label',
      metadata => {
        metadata.fields.velocity_umap.label = 'Velocity';
      },
    ],
    [
      'missing UMAP basis',
      metadata => {
        delete metadata.fields.velocity_umap.basis;
      },
    ],
    [
      'arbitrary basis',
      metadata => {
        metadata.fields.velocity_umap.basis = 'pca';
      },
    ],
    [
      'noncanonical vector path',
      metadata => {
        metadata.fields.velocity_umap.files['2d'] =
          'vectors/custom.bin';
      },
    ],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async t => {
      const working = await loadWorkingPreparedSource(t);
      const metadata = {
        default_field: 'velocity_umap',
        fields: {
          velocity_umap: {
            label: 'velocity_umap',
            available_dimensions: [2],
            default_dimension: 2,
            files: {
              '2d': 'vectors/velocity_umap_2d.bin',
            },
            basis: 'umap',
          },
        },
      };
      mutate(metadata);
      const field = Object.values(metadata.fields)[0];
      const path = field.files['2d'];
      await assert.rejects(
        working.source.loadFromPreparedDirectory(
          createPreparedDirectory(
            `invalid-exact-vector-${name.replaceAll(' ', '-')}`,
            {
              identityPayload: createPreparedIdentity({
                id: `invalid-exact-vector-${name.replaceAll(' ', '-')}`,
                vector_fields: metadata,
              }),
              extraFiles: [[
                path,
                float32Bytes([0, 0, 0, 0]),
              ]],
            }
          )
        ),
        /vector field|vector_fields|basis|label|path|portable/i
      );
      await assertWorkingPreparedSource(working);
    });
  }
});

test('valid zero-valued optional stats need no optional manifests', async t => {
  const source = new LocalUserDirDataSource();
  t.after(() => source.clear());

  const metadata = await source.loadFromPreparedDirectory(
    createPreparedDirectory('valid-empty-optional-data', {
      identityPayload: createPreparedIdentity({
        stats: {
          n_genes: 0,
          n_obs_fields: 0,
          n_categorical_fields: 0,
          n_continuous_fields: 0,
          has_connectivity: false,
          n_edges: null,
        },
      }),
    })
  );

  assert.deepEqual(metadata.stats, {
    n_cells: 2,
    n_genes: 0,
    n_obs_fields: 0,
    n_categorical_fields: 0,
    n_continuous_fields: 0,
    has_connectivity: false,
    n_edges: null,
  });
});

test('prepared manifests require the sole compact_v1 contract', async t => {
  await t.test('verbose observation manifest is rejected', async () => {
    const source = new LocalUserDirDataSource();
    t.after(() => source.clear());
    await assert.rejects(
      source.loadFromPreparedDirectory(
        createPreparedDirectory('verbose-obs', {
          obsText: JSON.stringify({
            version: 1,
            n_points: 2,
            fields: [],
          }),
        })
      ),
      /obs_manifest\.json.*compact_v1|compact_v1.*obs_manifest/i
    );
  });

  await t.test('verbose variable manifest is rejected', async () => {
    const source = new LocalUserDirDataSource();
    t.after(() => source.clear());
    await assert.rejects(
      source.loadFromPreparedDirectory(
        createPreparedDirectory('verbose-var', {
          identityPayload: createPreparedIdentity({
            stats: { n_genes: 1 },
          }),
          extraFiles: [[
            'var_manifest.json',
            JSON.stringify({
              version: 1,
              n_points: 2,
              fields: [{
                key: 'A',
                kind: 'continuous',
                valuesPath: 'var/A.values.f32',
                valuesDtype: 'float32',
              }],
            }),
          ], [
            'var/A.values.f32',
            float32Bytes([1, 2]),
          ]],
        })
      ),
      /var_manifest\.json.*compact_v1|compact_v1.*var_manifest/i
    );
  });
});

test('prepared embeddings publish only the exact current identity and advertised path', async t => {
  await t.test('a custom advertised path needs no conventional sibling', async () => {
    const source = new LocalUserDirDataSource();
    t.after(() => source.clear());
    const metadata = await source.loadFromPreparedDirectory(
      createPreparedDirectory('custom-embedding-name', {
        pointsFilename: 'advertised.bin',
        pointsContents: float32Bytes([0, 1, 2, 3]),
      })
    );
    assert.equal(
      metadata.embeddings.files['2d'],
      'advertised.bin'
    );
    assert.equal(Object.hasOwn(metadata, 'pointsFile'), false);
    assert.equal(
      validateDatasetIdentity(
        metadata,
        metadata.id,
        source.getType()
      ),
      metadata
    );
  });

  await t.test('structural metadata cannot also own coordinates', async () => {
    const source = new LocalUserDirDataSource();
    t.after(() => source.clear());
    const nCells = 128;
    const identity = createPreparedIdentity({
      nCells,
      pointsFilename: 'dataset_identity.json',
    });
    const compactIdentity = JSON.stringify(identity);
    const paddedIdentity =
      compactIdentity + ' '.repeat(
        nCells * 2 * Float32Array.BYTES_PER_ELEMENT -
          compactIdentity.length
      );
    const compactObs = JSON.stringify({
      _format: 'compact_v1',
      n_points: nCells,
      centroid_outlier_quantile: null,
      latent_key: null,
      compression: null,
      _obsSchemas: {},
      _continuousFields: [],
      _categoricalFields: [],
    });

    await assert.rejects(
      source.loadFromPreparedDirectory([
        createFile('metadata-alias/dataset_identity.json', paddedIdentity),
        createFile('metadata-alias/obs_manifest.json', compactObs),
        createFile(
          'metadata-alias/points_2d.bin',
          new Uint8Array(nCells * 2 * Float32Array.BYTES_PER_ELEMENT)
        ),
      ]),
      /dataset_identity\.json.*(metadata|structural|payload|reserved)/i
    );
  });
});

test('prepared exports reject aliased advertised payload paths', async t => {
  const fixtures = [
    {
      name: 'compact obs keys that sanitize to one values path',
      obsManifest: {
        _format: 'compact_v1',
        n_points: 2,
        centroid_outlier_quantile: null,
        latent_key: null,
        compression: null,
        _obsSchemas: {
          continuous: {
            pathPattern: 'obs/{key}.values.f32',
            ext: 'f32',
            dtype: 'float32',
            quantized: false,
          },
        },
        _continuousFields: [['A B'], ['A/B']],
        _categoricalFields: [],
      },
      extraFiles: [
        ['obs/A_B.values.f32', float32Bytes([1, 2])],
      ],
      expectedError: /field keys.*collide.*A_B/i,
    },
    {
      name: 'categorical fields with one codes path',
      obsManifest: {
        _format: 'compact_v1',
        n_points: 2,
        centroid_outlier_quantile: 0.95,
        latent_key: null,
        compression: null,
        _obsSchemas: {
          categorical: {
            codesPathPattern: 'obs/shared.codes.{ext}',
            outlierPathPattern: 'obs/{key}.outliers.f32',
            outlierExt: 'f32',
            outlierDtype: 'float32',
            outlierQuantized: false,
          },
        },
        _continuousFields: [],
        _categoricalFields: [
          ['first', ['A'], 'uint8', 255, { '2': [] }],
          ['second', ['B'], 'uint8', 255, { '2': [] }],
        ],
      },
      extraFiles: [
        ['obs/shared.codes.u8', new Uint8Array([0, 0])],
        ['obs/first.outliers.f32', float32Bytes([0.1, 0.2])],
        ['obs/second.outliers.f32', float32Bytes([0.3, 0.4])],
      ],
      expectedError: /codesPathPattern.*placeholders/i,
    },
    {
      name: 'categorical fields with one outlier path',
      obsManifest: {
        _format: 'compact_v1',
        n_points: 2,
        centroid_outlier_quantile: 0.95,
        latent_key: null,
        compression: null,
        _obsSchemas: {
          categorical: {
            codesPathPattern: 'obs/{key}.codes.{ext}',
            outlierPathPattern: 'obs/shared.outliers.f32',
            outlierExt: 'f32',
            outlierDtype: 'float32',
            outlierQuantized: false,
          },
        },
        _continuousFields: [],
        _categoricalFields: [
          ['first', ['A'], 'uint8', 255, { '2': [] }],
          ['second', ['B'], 'uint8', 255, { '2': [] }],
        ],
      },
      extraFiles: [
        ['obs/first.codes.u8', new Uint8Array([0, 0])],
        ['obs/second.codes.u8', new Uint8Array([0, 0])],
        ['obs/shared.outliers.f32', float32Bytes([0.1, 0.2])],
      ],
      expectedError: /outlierPathPattern.*placeholders/i,
    },
    {
      name: 'observation values that alias the embedding',
      obsManifest: {
        _format: 'compact_v1',
        n_points: 2,
        centroid_outlier_quantile: null,
        latent_key: null,
        compression: null,
        _obsSchemas: {
          continuous: {
            pathPattern: 'obs/{key}.values.f32',
            ext: 'f32',
            dtype: 'float32',
            quantized: false,
          },
        },
        _continuousFields: [['position_alias']],
        _categoricalFields: [],
      },
      extraFiles: [],
      expectedPath: 'obs/position_alias.values.f32',
      identityPayload: createPreparedIdentity({
        nCells: 2,
        pointsFilename: 'obs/position_alias.values.f32',
        name: 'Aliased embedding payload',
        embeddings: {
          available_dimensions: [1],
          default_dimension: 1,
          files: { '1d': 'obs/position_alias.values.f32' },
        },
      }),
      pointsFilename: 'obs/position_alias.values.f32',
      pointsContents: float32Bytes([0, 1]),
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, async t => {
      const source = new LocalUserDirDataSource();
      t.after(() => source.clear());
      const directory = createPreparedDirectory(
        `aliased-${fixture.name.replaceAll(' ', '-')}`,
        {
          obsText: JSON.stringify(fixture.obsManifest),
          extraFiles: fixture.extraFiles,
          identityPayload: fixture.identityPayload,
          pointsFilename: fixture.pointsFilename,
          pointsContents: fixture.pointsContents,
        }
      );

      await assert.rejects(
        source.loadFromPreparedDirectory(directory),
        fixture.expectedError ?? (error => (
          /advertised payload path.*more than once/i.test(
            error?.message || ''
          ) &&
          (error?.message || '').includes(fixture.expectedPath)
        ))
      );
    });
  }
});

test('local Zarr selections expose truthful visible folder and ZIP provenance', async t => {
  const originalDirectoryLoad = ZarrDataSource.prototype.loadFromFileList;
  const originalArchiveLoad = ZarrDataSource.prototype.loadFromArchiveFile;

  ZarrDataSource.prototype.loadFromFileList = async function (
    selection,
    options
  ) {
    const root = selection[0].webkitRelativePath.split('/')[0];
    this.dirname = root;
    this.datasetId = options.datasetId;
    this._metadata = {
      id: this.datasetId,
      name: root.replace(/\.zarr$/i, ''),
      description: options.description,
      source: options.source,
      stats: { n_cells: 2 }
    };
    return this._metadata;
  };
  ZarrDataSource.prototype.loadFromArchiveFile = async function (
    selection,
    options
  ) {
    const root = selection.name.replace(/\.zip$/i, '');
    this.dirname = root;
    this.datasetId = options.datasetId;
    this._metadata = {
      id: this.datasetId,
      name: root.replace(/\.zarr$/i, ''),
      description: options.description,
      source: options.source,
      stats: { n_cells: 2 }
    };
    return this._metadata;
  };
  t.after(() => {
    ZarrDataSource.prototype.loadFromFileList = originalDirectoryLoad;
    ZarrDataSource.prototype.loadFromArchiveFile = originalArchiveLoad;
  });

  const source = new LocalUserDirDataSource();
  t.after(() => source.clear());

  const archiveMetadata = await source.loadFromZarrArchive(
    createFile('portable.zarr.zip', 'synthetic ZIP')
  );
  assert.equal(
    archiveMetadata.id,
    'local-user:zarr-archive:zarr_portable'
  );
  assert.equal(archiveMetadata.source.name, 'Zarr ZIP archive');
  assert.equal(
    archiveMetadata.source.filename,
    'portable.zarr.zip',
    'the selected archive filename is part of its provenance'
  );
  assert.match(archiveMetadata.description, /Zarr ZIP archive/);
  assert.equal(
    (await source.getZarrSource().getMetadata(source.datasetId)).source.name,
    'Zarr ZIP archive',
    'the adopted inner source and local UI source must expose one identity'
  );

  const directoryMetadata = await source.loadFromZarrDirectory([
    createFile('folder.zarr/.zgroup', '{"zarr_format":2}')
  ]);
  assert.equal(
    directoryMetadata.id,
    'local-user:zarr-directory:zarr_folder'
  );
  assert.equal(directoryMetadata.source.name, 'Zarr directory');
  assert.match(directoryMetadata.description, /Zarr directory/);
  assert.doesNotMatch(directoryMetadata.description, /ZIP|archive/i);
  assert.equal(
    Object.hasOwn(directoryMetadata.source, 'filename'),
    false,
    'folder provenance must not retain an archive filename'
  );
});

test('local AnnData wrapper keeps nested datasource notifications silent', async t => {
  const originalH5adLoad = H5adDataSource.prototype.loadFromFile;
  const originalZarrDirectoryLoad =
    ZarrDataSource.prototype.loadFromFileList;
  const originalZarrArchiveLoad =
    ZarrDataSource.prototype.loadFromArchiveFile;
  const nestedOptions = [];

  H5adDataSource.prototype.loadFromFile =
    async function (file, options) {
      nestedOptions.push(['h5ad', options]);
      this.filename = file.name;
      this.datasetId = options.datasetId;
      this._metadata = {
        id: this.datasetId,
        name: 'nested h5ad',
        stats: { n_cells: 2 },
      };
      return this._metadata;
    };
  ZarrDataSource.prototype.loadFromFileList =
    async function (files, options) {
      nestedOptions.push(['zarr-directory', options]);
      this.dirname = files[0].webkitRelativePath.split('/')[0];
      this.datasetId = options.datasetId;
      this._metadata = {
        id: this.datasetId,
        name: 'nested zarr directory',
        source: {},
        stats: { n_cells: 2 },
      };
      return this._metadata;
    };
  ZarrDataSource.prototype.loadFromArchiveFile =
    async function (file, options) {
      nestedOptions.push(['zarr-archive', options]);
      this.dirname = file.name.replace(/\.zip$/i, '');
      this.datasetId = options.datasetId;
      this._metadata = {
        id: this.datasetId,
        name: 'nested zarr archive',
        source: {},
        stats: { n_cells: 2 },
      };
      return this._metadata;
    };
  t.after(() => {
    H5adDataSource.prototype.loadFromFile = originalH5adLoad;
    ZarrDataSource.prototype.loadFromFileList =
      originalZarrDirectoryLoad;
    ZarrDataSource.prototype.loadFromArchiveFile =
      originalZarrArchiveLoad;
  });

  const source = new LocalUserDirDataSource();
  t.after(() => source.clear());
  await source.loadFromH5adFile(
    createFile('nested.h5ad', 'h5ad')
  );
  await source.loadFromZarrDirectory([
    createFile('nested.zarr/.zgroup', '{"zarr_format":2}'),
  ]);
  await source.loadFromZarrArchive(
    createFile('nested.zarr.zip', 'zip')
  );

  assert.deepEqual(
    nestedOptions.map(([kind, options]) => [
      kind,
      options?.showProgress,
    ]),
    [
      ['h5ad', false],
      ['zarr-directory', false],
      ['zarr-archive', false],
    ]
  );
});

test('invalid local replacements leave the working prepared source usable', async t => {
  await t.test('prepared directory', async t => {
    const working = await loadWorkingPreparedSource(t);
    const invalidDirectory = [
      createFile(
        'broken/obs_manifest.json',
        JSON.stringify({ version: 1, n_points: 3, fields: [] })
      )
    ];

    await assert.rejects(
      working.source.loadFromPreparedDirectory(invalidDirectory),
      error => {
        assert.match(error.message, /missing required files/);
        assert.equal(
          error.details.missing.filter(
            value => value === 'dataset_identity.json'
          ).length,
          1,
          'each missing requirement should be reported once'
        );
        return true;
      }
    );
    await assertWorkingPreparedSource(working);
  });

  await t.test('prepared directory missing required identity', async t => {
    const working = await loadWorkingPreparedSource(t);
    const invalidDirectory = createPreparedDirectory('missing-identity')
      .filter(file => file.name !== 'dataset_identity.json');

    await assert.rejects(
      working.source.loadFromPreparedDirectory(invalidDirectory),
      /missing required files.*dataset_identity\.json/i
    );
    await assertWorkingPreparedSource(working);
  });

  await t.test('prepared directory with malformed observation manifest', async t => {
    const working = await loadWorkingPreparedSource(t);
    const invalidDirectory = createPreparedDirectory('bad-obs', {
      obsText: '{"n_points":',
    });

    await assert.rejects(
      working.source.loadFromPreparedDirectory(invalidDirectory),
      /invalid obs_manifest\.json/i
    );
    await assertWorkingPreparedSource(working);
  });

  await t.test('prepared directory with misaligned default positions', async t => {
    const working = await loadWorkingPreparedSource(t);
    const invalidDirectory = createPreparedDirectory('bad-points', {
      pointsContents: new Uint8Array(1),
    });

    await assert.rejects(
      working.source.loadFromPreparedDirectory(invalidDirectory),
      /points_2d\.bin.*expected 16 bytes.*found 1/i
    );
    await assertWorkingPreparedSource(working);
  });

  await t.test('prepared directory rejects an oversized position plan', async t => {
    const working = await loadWorkingPreparedSource(t);
    const invalidDirectory = createPreparedDirectory('oversized-points', {
      nCells: 67_108_865,
      pointsContents: new Uint8Array(1),
    });

    await assert.rejects(
      working.source.loadFromPreparedDirectory(invalidDirectory),
      /points_2d\.bin.*512 MiB.*server/i
    );
    await assertWorkingPreparedSource(working);
  });

  await t.test('prepared directory rejects a compressed expansion mismatch', async t => {
    const working = await loadWorkingPreparedSource(t);
    const invalidDirectory = createPreparedDirectory('gzip-bomb', {
      identityPayload: createPreparedIdentity({
        id: 'gzip-bomb',
        pointsFilename: 'points_2d.bin.gz',
        exportSettings: { compression: 6 },
      }),
      pointsFilename: 'points_2d.bin.gz',
      pointsContents: gzipSync(new Uint8Array(1024 * 1024)),
      obsText: JSON.stringify({
        _format: 'compact_v1',
        n_points: 2,
        centroid_outlier_quantile: null,
        latent_key: null,
        compression: 6,
        _obsSchemas: {},
        _continuousFields: [],
        _categoricalFields: [],
      }),
    });

    await assert.rejects(
      working.source.loadFromPreparedDirectory(invalidDirectory),
      /points_2d\.bin\.gz.*expected 16 bytes/i
    );
    await assertWorkingPreparedSource(working);
  });

  await t.test('prepared directory verifies compressed observation integrity', async t => {
    const working = await loadWorkingPreparedSource(t);
    const obsManifest = {
      _format: 'compact_v1',
      n_points: 2,
      centroid_outlier_quantile: null,
      latent_key: null,
      compression: 6,
      _obsSchemas: {
        continuous: {
          pathPattern: 'obs/{key}.values.f32.gz',
          ext: 'f32',
          dtype: 'float32',
          quantized: false,
        },
      },
      _continuousFields: [['score']],
      _categoricalFields: [],
    };
    const invalidDirectory = createPreparedDirectory('spoofed-obs-gzip', {
      identityPayload: createPreparedIdentity({
        id: 'spoofed-obs-gzip',
        pointsFilename: 'points_2d.bin.gz',
        stats: {
          n_obs_fields: 1,
          n_continuous_fields: 1,
          n_categorical_fields: 0,
        },
        exportSettings: { compression: 6 },
        obs_fields: [{ key: 'score', kind: 'continuous' }],
      }),
      pointsFilename: 'points_2d.bin.gz',
      pointsContents: gzipSync(
        new Uint8Array(2 * 2 * Float32Array.BYTES_PER_ELEMENT)
      ),
      obsText: JSON.stringify(obsManifest),
      extraFiles: [[
        'obs/score.values.f32.gz',
        spoofGzipSize(new Uint8Array(1024 * 1024), 8)
      ]],
    });

    await assert.rejects(
      working.source.loadFromPreparedDirectory(invalidDirectory),
      /score\.values\.f32\.gz.*(gzip|compressed|decompress|expected)/i
    );
    await assertWorkingPreparedSource(working);
  });

  await t.test('prepared directory validates an advertised variable manifest', async t => {
    const working = await loadWorkingPreparedSource(t);
    const invalidDirectory = createPreparedDirectory('bad-var-manifest', {
      identityPayload: createPreparedIdentity({
        stats: { n_genes: 1 },
      }),
      extraFiles: [['var_manifest.json', '{"n_points":']],
    });

    await assert.rejects(
      working.source.loadFromPreparedDirectory(invalidDirectory),
      /invalid var_manifest\.json/i
    );
    await assertWorkingPreparedSource(working);
  });

  await t.test('prepared directory requires every advertised gene payload', async t => {
    const working = await loadWorkingPreparedSource(t);
    const varManifest = {
      _format: 'compact_v1',
      n_points: 2,
      var_gene_id_column: null,
      compression: null,
      quantization: null,
      _varSchema: {
        kind: 'continuous',
        pathPattern: 'var/{key}.values.f32',
        ext: 'f32',
        dtype: 'float32',
        quantized: false,
      },
      fields: [['A']],
    };
    const invalidDirectory = createPreparedDirectory('missing-gene-values', {
      identityPayload: createPreparedIdentity({
        stats: { n_genes: 1 },
      }),
      extraFiles: [['var_manifest.json', JSON.stringify(varManifest)]],
    });

    await assert.rejects(
      working.source.loadFromPreparedDirectory(invalidDirectory),
      /gene.*A|var\/A\.values\.f32|missing.*payload/i
    );
    await assertWorkingPreparedSource(working);
  });

  await t.test('prepared directory validates advertised connectivity', async t => {
    const working = await loadWorkingPreparedSource(t);
    const invalidDirectory = createPreparedDirectory('bad-connectivity', {
      identityPayload: createPreparedIdentity({
        stats: {
          has_connectivity: true,
          n_edges: 1,
        },
      }),
      extraFiles: [['connectivity_manifest.json', '{']],
    });

    await assert.rejects(
      working.source.loadFromPreparedDirectory(invalidDirectory),
      /invalid connectivity_manifest\.json/i
    );
    await assertWorkingPreparedSource(working);
  });

  await t.test('prepared directory requires every advertised vector payload', async t => {
    const working = await loadWorkingPreparedSource(t);
    const invalidDirectory = createPreparedDirectory('missing-vector', {
      identityPayload: createPreparedIdentity({
        vector_fields: {
          default_field: 'velocity_umap',
          fields: {
            velocity_umap: {
              label: 'velocity_umap',
              available_dimensions: [2],
              default_dimension: 2,
              files: { '2d': 'vectors/velocity_umap_2d.bin' },
              basis: 'umap',
            },
          },
        },
      }),
    });

    await assert.rejects(
      working.source.loadFromPreparedDirectory(invalidDirectory),
      /vector.*velocity_umap|vectors\/velocity_umap_2d\.bin/i
    );
    await assertWorkingPreparedSource(working);
  });

  await t.test('prepared directory cross-checks identity observation summaries', async t => {
    const working = await loadWorkingPreparedSource(t);
    const invalidDirectory = createPreparedDirectory('mismatched-obs-summary', {
      identityPayload: createPreparedIdentity({
        stats: {
          n_obs_fields: 1,
          n_continuous_fields: 1,
          n_categorical_fields: 0,
        },
        obs_fields: [{ key: 'ghost', kind: 'continuous' }],
      }),
    });

    await assert.rejects(
      working.source.loadFromPreparedDirectory(invalidDirectory),
      /identity.*obs|obs.*identity|ghost/i
    );
    await assertWorkingPreparedSource(working);
  });

  await t.test('prepared directory rejects non-array identity obs_fields', async t => {
    const working = await loadWorkingPreparedSource(t);
    const invalidDirectory = createPreparedDirectory('object-obs-summary', {
      identityPayload: createPreparedIdentity({
        obs_fields: {
          score: { key: 'score', kind: 'continuous' },
        },
      }),
    });

    await assert.rejects(
      working.source.loadFromPreparedDirectory(invalidDirectory),
      /dataset_identity\.json.*obs_fields.*array/i
    );
    await assertWorkingPreparedSource(working);
  });

  await t.test('prepared directory rejects duplicate identity obs summaries', async t => {
    const working = await loadWorkingPreparedSource(t);
    const obsManifest = {
      _format: 'compact_v1',
      n_points: 2,
      centroid_outlier_quantile: null,
      latent_key: null,
      compression: null,
      _obsSchemas: {
        continuous: {
          pathPattern: 'obs/{key}.values.f32',
          ext: 'f32',
          dtype: 'float32',
          quantized: false,
        },
      },
      _continuousFields: [['first'], ['second']],
      _categoricalFields: [],
    };
    const invalidDirectory = createPreparedDirectory('duplicate-obs-summary', {
      identityPayload: createPreparedIdentity({
        stats: {
          n_obs_fields: 2,
          n_continuous_fields: 2,
          n_categorical_fields: 0,
        },
        obs_fields: [
          { key: 'first', kind: 'continuous' },
          { key: 'first', kind: 'continuous' },
        ],
      }),
      obsText: JSON.stringify(obsManifest),
      extraFiles: [
        ['obs/first.values.f32', float32Bytes([1, 2])],
        ['obs/second.values.f32', float32Bytes([3, 4])],
      ],
    });

    await assert.rejects(
      working.source.loadFromPreparedDirectory(invalidDirectory),
      /dataset_identity\.json.*obs_fields.*duplicate.*first/i
    );
    await assertWorkingPreparedSource(working);
  });

  await t.test('prepared directory validates optional stats without manifests', async t => {
    const working = await loadWorkingPreparedSource(t);
    const exactAbsentConnectivity = createPreparedDirectory(
      'exact-absent-connectivity',
      {
        identityPayload: createPreparedIdentity({
          stats: { has_connectivity: false, n_edges: null },
        }),
      }
    );
    const exactSource = new LocalUserDirDataSource();
    t.after(() => exactSource.clear());
    assert.equal(
      (
        await exactSource.loadFromPreparedDirectory(
          exactAbsentConnectivity
        )
      )
        .stats.n_edges,
      null
    );

    const cases = [
      {
        name: 'null gene count',
        stats: { n_genes: null },
        expected: /stats\.n_genes.*non-negative safe integer/i,
      },
      {
        name: 'string edge count',
        stats: { has_connectivity: false, n_edges: '0' },
        expected: /stats\.n_edges.*null.*has_connectivity.*false/i,
      },
      {
        name: 'negative edge count',
        stats: { has_connectivity: false, n_edges: -1 },
        expected: /stats\.n_edges.*null.*has_connectivity.*false/i,
      },
      {
        name: 'non-boolean connectivity flag',
        stats: { has_connectivity: 'false', n_edges: 0 },
        expected: /stats\.has_connectivity.*boolean/i,
      },
      {
        name: 'edges contradict a false connectivity flag',
        stats: { has_connectivity: false, n_edges: 1 },
        expected: /stats\.n_edges.*null.*has_connectivity.*false/i,
      },
      {
        name: 'true connectivity flag requires a manifest',
        stats: { has_connectivity: true, n_edges: 0 },
        expected: /connectivity.*missing/i,
      },
    ];

    for (const fixture of cases) {
      const invalidDirectory = createPreparedDirectory(
        `bad-connectivity-stats-${fixture.name.replaceAll(' ', '-')}`,
        {
          identityPayload: createPreparedIdentity({
            stats: fixture.stats,
          }),
        }
      );
      await assert.rejects(
        working.source.loadFromPreparedDirectory(invalidDirectory),
        fixture.expected,
        fixture.name
      );
      await assertWorkingPreparedSource(working);
    }
  });

  await t.test('prepared directory preflights raw plus padded embedding memory', async t => {
    const working = await loadWorkingPreparedSource(t);
    const nCells = 40_000_000;
    const expectedBytes =
      nCells * 2 * Float32Array.BYTES_PER_ELEMENT;
    const invalidDirectory = createPreparedDirectory('padding-peak', {
      nCells,
      pointsContents: new Uint8Array(0),
    });
    const pointsFile = invalidDirectory.find(
      file => file.name === 'points_2d.bin'
    );
    let streamTouched = false;
    Object.defineProperties(pointsFile, {
      size: {
        configurable: true,
        value: expectedBytes,
      },
      stream: {
        configurable: true,
        value() {
          streamTouched = true;
          throw new Error('oversized embedding must reject before streaming');
        },
      },
    });

    await assert.rejects(
      working.source.loadFromPreparedDirectory(invalidDirectory),
      /embedding.*working set.*512 MiB|points_2d\.bin.*512 MiB/i
    );
    assert.equal(streamTouched, false);
    await assertWorkingPreparedSource(working);
  });

  await t.test('H5AD file', async t => {
    const working = await loadWorkingPreparedSource(t);
    const originalLoad = H5adDataSource.prototype.loadFromFile;
    H5adDataSource.prototype.loadFromFile = async function () {
      throw new Error('synthetic invalid H5AD');
    };
    t.after(() => {
      H5adDataSource.prototype.loadFromFile = originalLoad;
    });

    await assert.rejects(
      working.source.loadFromH5adFile(
        createFile('broken.h5ad', 'not an HDF5 file')
      ),
      /synthetic invalid H5AD/
    );
    await assertWorkingPreparedSource(working);
  });

  await t.test('Zarr directory', async t => {
    const working = await loadWorkingPreparedSource(t);
    const originalLoad = ZarrDataSource.prototype.loadFromFileList;
    ZarrDataSource.prototype.loadFromFileList = async function () {
      throw new Error('synthetic invalid Zarr');
    };
    t.after(() => {
      ZarrDataSource.prototype.loadFromFileList = originalLoad;
    });

    await assert.rejects(
      working.source.loadFromZarrDirectory([
        createFile('broken.zarr/.zgroup', '{}')
      ]),
      /synthetic invalid Zarr/
    );
    await assertWorkingPreparedSource(working);
  });

  await t.test('Zarr ZIP archive', async t => {
    const working = await loadWorkingPreparedSource(t);
    const originalLoad = ZarrDataSource.prototype.loadFromArchiveFile;
    ZarrDataSource.prototype.loadFromArchiveFile = async function () {
      throw new Error('synthetic invalid Zarr ZIP');
    };
    t.after(() => {
      if (originalLoad === undefined) {
        delete ZarrDataSource.prototype.loadFromArchiveFile;
      } else {
        ZarrDataSource.prototype.loadFromArchiveFile = originalLoad;
      }
    });

    await assert.rejects(
      working.source.loadFromZarrArchive(
        createFile('broken.zarr.zip', 'not a ZIP archive')
      ),
      /synthetic invalid Zarr ZIP/
    );
    await assertWorkingPreparedSource(working);
  });
});

test('large gene exports reject missing payloads without streaming', async t => {
  const source = new LocalUserDirDataSource();
  t.after(() => source.clear());

  const directory = createLargePreparedGeneDirectory(
    'large-missing-gene',
    {
      payloadForIndex: ({ index }) => ({
        omit: index === 256,
      }),
    }
  );
  let geneStreams = 0;
  for (const file of directory) {
    if (!file.webkitRelativePath.includes('/var/')) continue;
    const stream = file.stream.bind(file);
    Object.defineProperty(file, 'stream', {
      configurable: true,
      value() {
        geneStreams++;
        return stream();
      },
    });
  }

  await assert.rejects(
    source.loadFromPreparedDirectory(directory),
    /Gene_0256\.values\.f32.*missing advertised payload/i
  );
  assert.equal(
    geneStreams,
    0,
    'missing lazy payloads should be detected by indexed-file lookup'
  );
});

test('large gene exports reject raw length mismatches without streaming', async t => {
  const source = new LocalUserDirDataSource();
  t.after(() => source.clear());

  const directory = createLargePreparedGeneDirectory(
    'large-wrong-size-gene',
    {
      payloadForIndex: ({ index }) => (
        index === 256
          ? { contents: new Uint8Array([0]) }
          : {}
      ),
    }
  );
  let geneStreams = 0;
  for (const file of directory) {
    if (!file.webkitRelativePath.includes('/var/')) continue;
    const stream = file.stream.bind(file);
    Object.defineProperty(file, 'stream', {
      configurable: true,
      value() {
        geneStreams++;
        return stream();
      },
    });
  }

  await assert.rejects(
    source.loadFromPreparedDirectory(directory),
    /Gene_0256\.values\.f32.*expected 8 bytes.*found 1/i
  );
  assert.equal(
    geneStreams,
    0,
    'raw lazy payload sizes should be checked without opening streams'
  );
});

test('8,234-file gene exports validate gzip integrity lazily on first access', async t => {
  const source = new LocalUserDirDataSource();
  t.after(() => source.clear());

  const nGenes = 8_230;
  const corruptGeneIndex = nGenes - 1;
  const directory = createLargePreparedGeneDirectory('large-lazy-genes', {
    gzipAll: true,
    nGenes,
    payloadForIndex: ({ index }) => (
      index === corruptGeneIndex
        ? {
            contents: corruptGzipCrc(float32Bytes([index, index + 1])),
          }
        : {}
    ),
  });
  assert.equal(directory.length, 8_234);

  let geneStreams = 0;
  let geneSlices = 0;
  for (const file of directory) {
    if (!file.webkitRelativePath.includes('/var/')) continue;
    const stream = file.stream.bind(file);
    const slice = file.slice.bind(file);
    Object.defineProperty(file, 'stream', {
      configurable: true,
      value() {
        geneStreams++;
        return stream();
      },
    });
    Object.defineProperty(file, 'slice', {
      configurable: true,
      value(...args) {
        geneSlices++;
        return slice(...args);
      },
    });
  }

  await source.loadFromPreparedDirectory(directory);
  assert.equal(
    geneStreams,
    0,
    'folder adoption must not stream every payload in a large gene manifest'
  );
  assert.equal(
    geneSlices,
    0,
    'folder adoption must not issue asynchronous slices for lazy genes'
  );

  const baseUrl = source.getBaseUrl(source.datasetId);
  await assert.rejects(
    source.resolveUrl(
      `${baseUrl}var/Gene_8229.values.f32.gz`,
      null
    ),
    /Gene_8229\.values\.f32\.gz.*(gzip|compressed|binary|checksum|invalid)/i
  );
  assert.equal(
    geneStreams,
    1,
    'the requested corrupt gzip should receive one full integrity scan'
  );
  assert.equal(
    geneSlices,
    2,
    'only the requested gzip envelope should read its header and trailer'
  );

  assert.match(
    await source.resolveUrl(
      `${baseUrl}var/Gene_0000.values.f32.gz`,
      null
    ),
    /^blob:/
  );
  assert.equal(
    geneStreams,
    2,
    'only requested genes should receive full integrity scans'
  );
  assert.equal(
    geneSlices,
    4,
    'each requested gzip should receive one header and one trailer read'
  );
});

test('superseded prepared validation aborts its active stream promptly', async () => {
  const source = new LocalUserDirDataSource();
  const readStarted = deferred();
  const readGate = deferred();
  let readerCancelled = false;
  const candidate = createPreparedDirectory('slow-stream');
  const pointsFile = candidate.find(file => file.name === 'points_2d.bin');
  Object.defineProperty(pointsFile, 'stream', {
    configurable: true,
    value() {
      return {
        getReader() {
          return {
            cancel() {
              readerCancelled = true;
              const error = new Error('synthetic stream cancellation');
              error.name = 'AbortError';
              readGate.reject(error);
              return Promise.resolve();
            },
            read() {
              readStarted.resolve();
              return readGate.promise;
            },
            releaseLock() {},
          };
        },
      };
    },
  });

  const loading = source.loadFromPreparedDirectory(candidate);
  const outcomePromise = loading.then(
    value => ({ value }),
    error => ({ error })
  );
  await readStarted.promise;
  source.clear();
  await Promise.resolve();
  const cancelledAtClear = readerCancelled;
  if (!readerCancelled) readGate.resolve({ done: true });
  const outcome = await outcomePromise;

  assert.equal(cancelledAtClear, true);
  assert.equal(outcome.error?.name, 'AbortError');
  assert.equal(
    outcome.error?.code,
    'CELLUCID_DATASET_RELOAD_SUPERSEDED'
  );
});

test('prepared URL resolution requires and observes its exact owner signal', async () => {
  const source = new LocalUserDirDataSource();
  const readStarted = deferred();
  const readGate = deferred();
  let readerCancelled = false;
  const directory = createLargePreparedGeneDirectory(
    'owner-aborted-lazy-file',
    { nGenes: 257 }
  );
  const targetPath = 'var/Gene_0256.values.f32';
  const targetFile = directory.find(
    file => file.webkitRelativePath.endsWith(`/${targetPath}`)
  );
  Object.defineProperty(targetFile, 'stream', {
    configurable: true,
    value() {
      return {
        getReader() {
          return {
            cancel() {
              readerCancelled = true;
              const error = new Error('synthetic owner cancellation');
              error.name = 'AbortError';
              readGate.reject(error);
              return Promise.resolve();
            },
            read() {
              readStarted.resolve();
              return readGate.promise;
            },
            releaseLock() {},
          };
        },
      };
    },
  });

  try {
    await source.loadFromPreparedDirectory(directory);
    const url = `${source.getBaseUrl(source.datasetId)}${targetPath}`;
    await assert.rejects(
      source.resolveUrl(url),
      /signal.*AbortSignal or exact null/i
    );

    const controller = new AbortController();
    const resolving = source.resolveUrl(url, controller.signal);
    await readStarted.promise;
    controller.abort();
    await assert.rejects(
      resolving,
      error => error?.name === 'AbortError'
    );
    assert.equal(readerCancelled, true);
  } finally {
    if (!readerCancelled) readGate.resolve({ done: true });
    source.clear();
  }
});

for (const flow of [
  {
    name: 'H5AD',
    expectedDatasetId: 'local-user:h5ad:h5ad_newer',
    prototype: H5adDataSource.prototype,
    method: 'loadFromFile',
    createSelection(name) {
      return [createFile(`${name}.h5ad`, name)];
    },
    invoke(source, selection) {
      return source.loadFromH5adFile(selection[0]);
    },
    async installCandidate(candidate, selection, options) {
      const file = selection;
      candidate.filename = file.name;
      candidate.datasetId = options.datasetId;
      candidate._metadata = {
        id: candidate.datasetId,
        name: file.name,
        stats: { n_cells: 2 }
      };
      return candidate._metadata;
    },
    getActiveCandidate(source) {
      return source.getH5adSource();
    }
  },
  {
    name: 'Zarr',
    expectedDatasetId:
      'local-user:zarr-directory:zarr_newer',
    prototype: ZarrDataSource.prototype,
    method: 'loadFromFileList',
    createSelection(name) {
      return [createFile(`${name}.zarr/.zgroup`, '{}')];
    },
    invoke(source, selection) {
      return source.loadFromZarrDirectory(selection);
    },
    async installCandidate(candidate, selection, options) {
      const root = selection[0].webkitRelativePath.split('/')[0];
      candidate.dirname = root;
      candidate.datasetId = options.datasetId;
      candidate._metadata = {
        id: candidate.datasetId,
        name: root,
        stats: { n_cells: 2 }
      };
      return candidate._metadata;
    },
    getActiveCandidate(source) {
      return source.getZarrSource();
    }
  },
  {
    name: 'Zarr ZIP',
    expectedDatasetId:
      'local-user:zarr-archive:zarr_newer',
    prototype: ZarrDataSource.prototype,
    method: 'loadFromArchiveFile',
    createSelection(name) {
      return [createFile(`${name}.zarr.zip`, name)];
    },
    invoke(source, selection) {
      return source.loadFromZarrArchive(selection[0]);
    },
    async installCandidate(candidate, selection, options) {
      const root = selection.name.replace(/\.zip$/i, '');
      candidate.dirname = root;
      candidate.datasetId = options.datasetId;
      candidate._metadata = {
        id: candidate.datasetId,
        name: root,
        stats: { n_cells: 2 }
      };
      return candidate._metadata;
    },
    getActiveCandidate(source) {
      return source.getZarrSource();
    }
  }
]) {
  test(`overlapping ${flow.name} selections explicitly supersede the older load`, async t => {
    const source = new LocalUserDirDataSource();
    t.after(() => source.clear());

    const gates = new Map([
      ['older', deferred()],
      ['newer', deferred()]
    ]);
    const candidates = [];
    const originalLoad = flow.prototype[flow.method];
    flow.prototype[flow.method] = async function (selection, options) {
      candidates.push(this);
      const selectionName = flow.name === 'H5AD'
        ? selection.name.replace(/\.h5ad$/i, '')
        : flow.name === 'Zarr ZIP'
          ? selection.name.replace(/\.zarr\.zip$/i, '')
          : selection[0].webkitRelativePath.split('/')[0].replace(/\.zarr$/i, '');
      await gates.get(selectionName).promise;
      return flow.installCandidate(this, selection, options);
    };
    t.after(() => {
      if (originalLoad === undefined) {
        delete flow.prototype[flow.method];
      } else {
        flow.prototype[flow.method] = originalLoad;
      }
    });

    const olderLoad = flow.invoke(
      source,
      flow.createSelection('older')
    );
    const newerLoad = flow.invoke(
      source,
      flow.createSelection('newer')
    );
    t.after(async () => {
      gates.get('older').resolve();
      gates.get('newer').resolve();
      await Promise.allSettled([olderLoad, newerLoad]);
    });
    assert.equal(candidates.length, 2, 'both selections must reach separate candidates');

    gates.get('newer').resolve();
    const newerMetadata = await newerLoad;
    gates.get('older').resolve();
    const olderOutcome = await Promise.allSettled([olderLoad]).then(
      ([outcome]) => outcome
    );

    assert.equal(
      newerMetadata.name,
      flow.name === 'H5AD' ? 'newer.h5ad' : 'newer.zarr'
    );
    assert.equal(
      source.datasetId,
      flow.expectedDatasetId
    );
    assert.equal(flow.getActiveCandidate(source), candidates[1]);
    assert.equal(
      olderOutcome.status,
      'rejected',
      'the older selection must not fulfill through the newer mutable candidate'
    );
    assert.equal(
      isExplicitSupersession(olderOutcome.reason),
      true,
      `older ${flow.name} load must report that a newer selection superseded it`
    );
    assert.equal(
      olderOutcome.reason?.code,
      'CELLUCID_DATASET_RELOAD_SUPERSEDED'
    );
  });
}

test('overlapping prepared-directory selections preserve the newest dataset', async t => {
  const source = new LocalUserDirDataSource();
  t.after(() => source.clear());

  const olderIdentity = deferred();
  const olderLoad = source.loadFromPreparedDirectory(
    createPreparedDirectory('older', {
      displayName: 'Older dataset',
      identityText: () => olderIdentity.promise
    })
  );
  const newerLoad = source.loadFromPreparedDirectory(
    createPreparedDirectory('newer', {
      displayName: 'Newer dataset'
    })
  );

  const newerMetadata = await newerLoad;
  olderIdentity.resolve(
    JSON.stringify({
      version: 2,
      name: 'Older dataset',
      stats: { n_cells: 2 }
    })
  );
  const olderOutcome = await Promise.allSettled([olderLoad]).then(
    ([outcome]) => outcome
  );

  assert.equal(newerMetadata.name, 'Newer dataset');
  assert.equal(
    (await source.getMetadata(source.datasetId)).name,
    'Newer dataset',
    'a stale prepared-directory read must not overwrite the newest metadata'
  );
  assert.equal(
    olderOutcome.status,
    'rejected',
    'the older prepared-directory selection must be explicitly superseded'
  );
  assert.equal(
    isExplicitSupersession(olderOutcome.reason),
    true,
    'the stale prepared-directory load must explain that a newer selection superseded it'
  );
  assert.equal(
    olderOutcome.reason?.code,
    'CELLUCID_DATASET_RELOAD_SUPERSEDED'
  );
});
