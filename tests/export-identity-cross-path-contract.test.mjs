import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import { loaderMetadata, obsmColumnReader } from './helpers/anndata-mapping-mocks.mjs';
import {
  embeddingPayloadPath,
  identityPayloadCompression,
  validateDatasetIdentity,
  validateVectorFieldsMetadata,
  vectorPayloadPath,
} from '../assets/js/data/data-source.js';
import { expandObsManifest } from '../assets/js/data/data-loaders.js';
import {
  validateDatasetGeneration,
} from '../assets/js/data/dataset-generation-contract.js';
import {
  DimensionManager,
  parseEmbeddingMetadata,
} from '../assets/js/data/dimension-manager.js';
import {
  LocalUserDirDataSource,
} from '../assets/js/data/local-user-source.js';
import { resolveExportDataMapping } from '../assets/js/data/dataset-mapping.js';
import {
  VectorFieldManager,
  resolveVectorFields,
} from '../assets/js/data/vector-field-manager.js';
import { connectivityEdgesOf } from '../assets/js/data/sparse-utils.js';

// One format, every reader and every producer the web app meets.
//
// The on-disk export format is a contract between five repositories. The web
// app reads a prepared export two ways — over HTTP from a catalog, and straight
// out of a folder the user picked — and it also meets two producers that are
// not exports at all: the in-browser H5AD/Zarr adapters, and `cellucid serve`
// of an AnnData object. Whenever two of these disagree about what an identity
// may contain or how it is shaped, a dataset that loads one way fails another.
// The cases below feed the same fixture to every reader, and the same shape
// assertions to every producer.

const N_CELLS = 3;

function createFile(path, contents) {
  const normalizedPath = path.replace(/\\/g, '/');
  const file = new Blob([contents]);
  Object.defineProperties(file, {
    name: {
      configurable: true,
      value: normalizedPath.split('/').at(-1),
    },
    webkitRelativePath: {
      configurable: true,
      value: normalizedPath,
    },
  });
  return file;
}

function float32Bytes(values) {
  const bytes = new Uint8Array(
    values.length * Float32Array.BYTES_PER_ELEMENT
  );
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, value, true);
  });
  return bytes;
}

/**
 * One complete, spec-conformant prepared-export identity: uncompressed,
 * unquantized, two obs fields, two 2D embeddings (so the default is a choice,
 * not the only item), and one vector field bound to the default embedding on
 * the producer's exact payload path.
 */
function createExportIdentity(id) {
  return {
    version: 3,
    id,
    name: 'Cross-path export',
    description: '',
    created_at: '2026-01-02T03:04:05Z',
    cellucid_data_version: 'test-current',
    stats: {
      n_cells: N_CELLS,
      n_genes: 0,
      n_obs_fields: 2,
      n_categorical_fields: 1,
      n_continuous_fields: 1,
      has_connectivity: false,
      n_edges: null,
    },
    embeddings: {
      default_dimension: 2,
      defaults: { '2d': 'X_umap' },
      items: {
        X_pca: {
          label: 'PCA',
          dimension: 2,
          file: 'embeddings/0_2d.bin',
          source: { key: 'X_pca', columns: [0, 1] },
        },
        X_umap: {
          label: 'UMAP',
          dimension: 2,
          file: 'embeddings/1_2d.bin',
          source: { key: 'X_umap', columns: [0, 1] },
        },
      },
    },
    obs_fields: [
      { key: 'score', kind: 'continuous' },
      { key: 'cluster', kind: 'category', n_categories: 2 },
    ],
    export_settings: {
      compression: null,
      var_quantization: null,
      obs_continuous_quantization: null,
      obs_categorical_dtype: 'uint8',
    },
    vector_fields: {
      default_field: 'velocity',
      fields: {
        velocity: {
          label: 'velocity',
          files: { X_umap: 'vectors/0_1.bin' },
        },
      },
    },
  };
}

function createObsManifest() {
  return {
    _format: 'compact_v2',
    n_points: N_CELLS,
    centroid_outlier_quantile: 0.95,
    latent_key: 'latent_space',
    compression: null,
    _obsSchemas: {
      continuous: {
        pathPattern: 'obs/{index}.values.f32',
        ext: 'f32',
        dtype: 'float32',
        quantized: false,
      },
      categorical: {
        codesPathPattern: 'obs/{index}.codes.{ext}',
        outlierPathPattern: 'obs/{index}.outliers.f32',
        outlierExt: 'f32',
        outlierDtype: 'float32',
        outlierQuantized: false,
      },
    },
    _continuousFields: [[0, 'score']],
    _categoricalFields: [[
      1,
      'cluster',
      ['A', 'B'],
      'uint8',
      255,
      {
        X_pca: [{ category: 'A', position: [0.5, 0], n_points: 1 }],
        X_umap: [{ category: 'A', position: [-1, -1], n_points: 1 }],
      },
    ]],
  };
}

function createExportDirectory(id, identity, obsManifest = createObsManifest()) {
  return [
    createFile(
      `${id}/dataset_identity.json`,
      JSON.stringify(identity)
    ),
    createFile(
      `${id}/obs_manifest.json`,
      JSON.stringify(obsManifest)
    ),
    createFile(
      `${id}/embeddings/0_2d.bin`,
      float32Bytes([0.5, 0, -0.5, 1, 0, -1])
    ),
    createFile(
      `${id}/embeddings/1_2d.bin`,
      float32Bytes([-1, -1, 1, 0, 0, 1])
    ),
    createFile(
      `${id}/obs/0.values.f32`,
      float32Bytes([0.25, 0.5, 0.75])
    ),
    createFile(
      `${id}/obs/1.codes.u8`,
      new Uint8Array([0, 1, 255])
    ),
    createFile(
      `${id}/obs/1.outliers.f32`,
      float32Bytes([0.1, 0.2, 0.3])
    ),
    createFile(
      `${id}/vectors/0_1.bin`,
      float32Bytes([0.1, 0, 0.2, 0, 0.3, 0])
    ),
  ];
}

// What `cellucid serve` publishes for an AnnData object with obs `score`
// (float32) and `cluster` (categories A, B), obsm `X_umap_2d`, `X_umap_3d`,
// `velocity_umap_2d`, and `velocity_umap_3d`, served with vector fields and
// `centroid_min_points=1`: the output of cellucid-python
// `AnnDataAdapter.get_dataset_identity()` and `get_obs_manifest()`, recorded
// verbatim (the served created_at is the build time; a fixed one stands in).
// The direct H5AD/Zarr fixture below holds the same AnnData.
const SERVED_IDENTITY = Object.freeze({
  version: 3,
  id: 'served-cross-path',
  name: 'Served cross-path',
  description: 'Loaded directly from AnnData',
  created_at: '2026-01-02T03:04:05Z',
  cellucid_data_version: 'anndata_adapter',
  stats: {
    n_cells: 3,
    n_genes: 0,
    n_obs_fields: 2,
    n_categorical_fields: 1,
    n_continuous_fields: 1,
    has_connectivity: false,
    n_edges: null,
  },
  embeddings: {
    default_dimension: 3,
    defaults: { '2d': 'X_umap_2d', '3d': 'X_umap_3d' },
    items: {
      X_umap_2d: {
        label: 'X_umap_2d',
        dimension: 2,
        file: 'embeddings/0_2d.bin',
        source: { key: 'X_umap_2d', columns: [0, 1] },
      },
      X_umap_3d: {
        label: 'X_umap_3d',
        dimension: 3,
        file: 'embeddings/1_3d.bin',
        source: { key: 'X_umap_3d', columns: [0, 1, 2] },
      },
    },
  },
  obs_fields: [
    { key: 'score', kind: 'continuous' },
    { key: 'cluster', kind: 'category', n_categories: 2 },
  ],
  source: { name: 'In-memory AnnData' },
  vector_fields: {
    default_field: 'velocity_umap',
    fields: {
      velocity_umap: {
        label: 'velocity_umap',
        files: {
          X_umap_2d: 'vectors/0_0.bin',
          X_umap_3d: 'vectors/0_1.bin',
        },
      },
    },
  },
});

const SERVED_OBS_MANIFEST = Object.freeze({
  _format: 'compact_v2',
  n_points: 3,
  centroid_outlier_quantile: 0.95,
  latent_key: null,
  compression: null,
  _obsSchemas: {
    continuous: {
      pathPattern: 'obs/{index}.values.f32',
      ext: 'f32',
      dtype: 'float32',
      quantized: false,
    },
    categorical: {
      codesPathPattern: 'obs/{index}.codes.{ext}',
      outlierPathPattern: null,
      outlierExt: null,
      outlierDtype: null,
      outlierQuantized: false,
    },
  },
  _continuousFields: [[0, 'score']],
  _categoricalFields: [[1, 'cluster', ['A', 'B'], 'uint8', 255, {
    X_umap_2d: [
      { category: 'A', position: [0.0, -0.25], n_points: 2 },
      { category: 'B', position: [0.0, 0.5], n_points: 1 },
    ],
    X_umap_3d: [
      { category: 'A', position: [0.0, -0.25, -0.5], n_points: 2 },
      { category: 'B', position: [0.0, 0.5, 1.0], n_points: 1 },
    ],
  }]],
});

/** The same AnnData as SERVED_IDENTITY, behind the private H5AD/Zarr loader. */
function createDirectLoader() {
  const obsm = {
    X_umap_2d: { data: Float32Array.from([-2, -1, 0, 1, 2, 0]), nDims: 2 },
    X_umap_3d: {
      data: Float32Array.from([-2, -1, 0, 0, 1, 2, 2, 0, -2]),
      nDims: 3,
    },
    velocity_umap_2d: { data: Float32Array.from([1, 0, 0, 1, -1, 0]), nDims: 2 },
    velocity_umap_3d: {
      data: Float32Array.from([1, 0, 0, 0, 1, 0, -1, 0, 1]),
      nDims: 3,
    },
  };
  return {
    nObs: N_CELLS,
    nVars: 0,
    hasExpressionMatrix: false,
    varNames: [],
    obsKeys: ['score', 'cluster'],
    async getDatasetMetadata() {
      // The private adapter-construction descriptor; never published.
      return loaderMetadata({
        nObs: N_CELLS,
        obsm: Object.fromEntries(
          Object.entries(obsm).map(([key, value]) => [key, value.nDims])
        ),
        obsFields: ['score', 'cluster'],
        stats: { n_categorical_fields: 1, n_continuous_fields: 1 },
      });
    },
    async getObsFieldInfo(key) {
      if (key === 'score') return { dtype: 'float' };
      if (key === 'cluster') {
        return { dtype: 'categorical', categories: ['A', 'B'], ordered: false };
      }
      throw new Error(`Unexpected observation field "${key}"`);
    },
    async getObsField(key) {
      if (key === 'score') {
        return { dtype: 'float', values: Float32Array.from([0.25, 0.5, 0.75]) };
      }
      if (key === 'cluster') {
        return {
          dtype: 'categorical',
          categories: ['A', 'B'],
          codes: Int32Array.from([0, 1, 0]),
          ordered: false,
        };
      }
      throw new Error(`Unexpected observation field "${key}"`);
    },
    releaseObsField() {},
    readObsmColumns: obsmColumnReader(Object.fromEntries(
      Object.entries(obsm).map(([key, value]) => [key, { data: value.data, width: value.nDims }])
    )),
    async getConnectivityEdges() {
      return connectivityEdgesOf(await this.readConnectivityMatrix(), this.nObs);
    },
    async readConnectivityMatrix() {
      return null;
    },
    async getMatrixColumn() {
      throw new Error('X=None must not expose gene expression');
    },
    async readVarNames() {
      throw new Error('X=None must not expose gene names');
    },
    close() {},
  };
}

async function createDirectIdentity(format) {
  const adapter = new BaseAnnDataAdapter(createDirectLoader());
  await adapter.initialize();
  const identity = await adapter.finalizeDirectIdentity({
    id: `direct-${format}-cross-path`,
    name: `Direct ${format}`,
    description: '',
    cellucidDataVersion: `${format}_loader`,
    source: {
      name: format === 'h5ad' ? 'H5AD file' : 'Zarr store',
      filename: format === 'h5ad' ? 'cross.h5ad' : 'cross.zarr',
    },
  });
  return { adapter, identity };
}

async function loadLocally(t, id, identity) {
  const source = new LocalUserDirDataSource();
  t.after(() => source.clear());
  return source.loadFromPreparedDirectory(
    createExportDirectory(id, identity)
  );
}

async function rejectedLocally(t, id, identity, obsManifest) {
  const source = new LocalUserDirDataSource();
  t.after(() => source.clear());
  try {
    await source.loadFromPreparedDirectory(
      createExportDirectory(id, identity, obsManifest)
    );
  } catch (error) {
    return error;
  }
  return null;
}

function rejectedRemotely(id, identity) {
  try {
    validateDatasetIdentity(identity, id, 'remote');
  } catch (error) {
    return error;
  }
  return null;
}

/** A real dimension manager over an identity's embeddings, as the viewer builds it. */
function dimensionManagerFor(identity) {
  return new DimensionManager({ embeddingsMetadata: identity.embeddings });
}

/**
 * The runtime vector manager over the vector fields an identity declares,
 * read as a prepared export is: through the export mapping that uses every
 * declared binding.
 */
function vectorManagerFor(identity, dimensionManager = dimensionManagerFor(identity)) {
  return new VectorFieldManager({
    baseUrl: 'https://example.test/dataset/',
    vectorFields: resolveVectorFields({
      identity,
      mapping: resolveExportDataMapping(identity, null),
      candidates: null,
      dimensionManager,
    }),
    dimensionManager,
  });
}

const OPTIONAL_TOP_LEVEL_KEYS = Object.freeze([
  'created_at',
  'export_settings',
  'source',
  'vector_fields',
]);

/**
 * The structural shape of a version-3 identity, independent of its ids and
 * values: every key set the format fixes, collected over every item and
 * field. Two producers that agree on the format have equal shapes.
 */
function v3Shape(identity) {
  const unique = values => [...new Set(values.map(value => JSON.stringify(value)))]
    .map(value => JSON.parse(value));
  const items = Object.values(identity.embeddings.items);
  const fields = Object.values(identity.vector_fields?.fields ?? {});
  return {
    version: identity.version,
    requiredTopLevel: Object.keys(identity)
      .filter(key => !OPTIONAL_TOP_LEVEL_KEYS.includes(key))
      .sort(),
    embeddings: Object.keys(identity.embeddings),
    item: unique(items.map(item => Object.keys(item))),
    itemSource: unique(items.map(item => Object.keys(item.source))),
    vectorFields: Object.keys(identity.vector_fields ?? {}),
    field: unique(fields.map(field => Object.keys(field))),
  };
}

const V3_SHAPE = Object.freeze({
  version: 3,
  requiredTopLevel: [
    'cellucid_data_version',
    'description',
    'embeddings',
    'id',
    'name',
    'obs_fields',
    'stats',
    'version',
  ],
  embeddings: ['default_dimension', 'defaults', 'items'],
  item: [['label', 'dimension', 'file', 'source']],
  itemSource: [['key', 'columns']],
  vectorFields: ['default_field', 'fields'],
  field: [['label', 'files']],
});

/**
 * Assert the producer rules a shape alone cannot express: item order, exact
 * payload paths, the slot defaults, and vector labels equal to ids.
 */
function assertV3Rules(identity, label) {
  const compression = identityPayloadCompression(identity);
  const itemIds = Object.keys(identity.embeddings.items);
  const itemIndex = new Map(itemIds.map((id, index) => [id, index]));
  const sorted = [...itemIds].sort((left, right) => {
    const a = identity.embeddings.items[left];
    const b = identity.embeddings.items[right];
    return a.dimension - b.dimension || (left < right ? -1 : left > right ? 1 : 0);
  });
  assert.deepEqual(itemIds, sorted, `${label}: items in (dimension, id) order`);
  for (const [id, item] of Object.entries(identity.embeddings.items)) {
    assert.equal(
      item.file,
      embeddingPayloadPath(itemIndex.get(id), item.dimension, compression),
      `${label}: ${id} file`
    );
    assert.equal(item.source.columns.length, item.dimension);
  }
  const slots = [...new Set(Object.values(identity.embeddings.items)
    .map(item => `${item.dimension}d`))];
  assert.deepEqual(Object.keys(identity.embeddings.defaults), slots);
  for (const [slot, id] of Object.entries(identity.embeddings.defaults)) {
    assert.equal(`${identity.embeddings.items[id].dimension}d`, slot);
  }
  assert.ok(Object.hasOwn(
    identity.embeddings.defaults,
    `${identity.embeddings.default_dimension}d`
  ));
  for (const item of Object.values(identity.embeddings.items)) {
    assert.match(
      item.file,
      /^embeddings\/\d+_[123]d\.bin(\.gz)?$/,
      `${label}: every coordinate file is on the embeddings/ axis`
    );
  }

  const fieldIds = Object.keys(identity.vector_fields?.fields ?? {});
  assert.deepEqual(fieldIds, [...fieldIds].sort(), `${label}: field order`);
  fieldIds.forEach((fieldId, fieldIndex) => {
    const field = identity.vector_fields.fields[fieldId];
    assert.equal(field.label, fieldId, `${label}: vector label equals its id`);
    const bound = Object.keys(field.files);
    assert.ok(bound.length > 0);
    assert.deepEqual(
      bound,
      [...bound].sort((left, right) => itemIndex.get(left) - itemIndex.get(right)),
      `${label}: files in item order`
    );
    for (const [embeddingId, path] of Object.entries(field.files)) {
      assert.ok(itemIndex.has(embeddingId), `${label}: ${embeddingId} is an item`);
      assert.equal(
        path,
        vectorPayloadPath(fieldIndex, itemIndex.get(embeddingId), compression),
        `${label}: ${fieldId} on ${embeddingId}`
      );
    }
  });

  // Every runtime consumer reads the identity the same way.
  const parsed = parseEmbeddingMetadata(identity.embeddings);
  assert.deepEqual(parsed.layouts.map(layout => layout.layoutKey), itemIds);
  const vectors = vectorManagerFor(identity);
  for (const descriptor of vectors.getAvailableFields()) {
    assert.equal(descriptor.label, descriptor.id, `${label}: runtime label`);
    assert.deepEqual(
      descriptor.layoutKeys,
      Object.keys(identity.vector_fields.fields[descriptor.id].files)
    );
  }
}

test('the optional identity keys are optional on every reader', async t => {
  // created_at and export_settings are optional top-level keys of
  // dataset_identity.json. Both writers always emit them, so no shipped dataset
  // is affected either way — but a third-party export that follows the spec and
  // leaves them out must not load over HTTP and fail from a local folder.
  const variants = [
    ['both keys present', identity => identity],
    ['created_at omitted', identity => {
      delete identity.created_at;
      return identity;
    }],
    ['export_settings omitted', identity => {
      delete identity.export_settings;
      return identity;
    }],
    ['both optional keys omitted', identity => {
      delete identity.created_at;
      delete identity.export_settings;
      return identity;
    }],
  ];

  for (const [name, mutate] of variants) {
    await t.test(name, async t => {
      const id = `cross-path-${name.replaceAll(' ', '-')}`;
      const identity = mutate(createExportIdentity(id));

      assert.equal(
        rejectedRemotely(id, identity),
        null,
        'the hosted-catalog reader must accept this identity'
      );
      const metadata = await loadLocally(t, id, identity);
      assert.equal(metadata.id, `local-user:${id}`);
      assert.equal(
        Object.hasOwn(metadata, 'created_at'),
        Object.hasOwn(identity, 'created_at')
      );
      assert.equal(
        Object.hasOwn(metadata, 'export_settings'),
        Object.hasOwn(identity, 'export_settings')
      );
      assert.deepEqual(metadata.embeddings, identity.embeddings);
      assert.deepEqual(metadata.vector_fields, identity.vector_fields);
    });
  }
});

test('payload compression is export_settings.compression, and absent settings mean uncompressed', async t => {
  // An identity names its own payload paths, so the reader derives the
  // expected `.gz` suffix from the identity itself: export_settings when the
  // producer wrote it, otherwise uncompressed. A `.gz` embedding path without
  // export_settings is therefore not a well-formed identity on any reader.
  const cases = [
    [
      'a .gz embedding path with no export_settings',
      identity => {
        delete identity.export_settings;
        identity.embeddings.items.X_pca.file = 'embeddings/0_2d.bin.gz';
      },
      /embeddings\.items\.X_pca\.file must be exactly "embeddings\/0_2d\.bin"/,
    ],
    [
      'an uncompressed embedding path under compression 6',
      identity => {
        identity.export_settings.compression = 6;
      },
      /embeddings\.items\.X_pca\.file must be exactly "embeddings\/0_2d\.bin\.gz"/,
    ],
    [
      'a .gz vector path with no export_settings',
      identity => {
        delete identity.export_settings;
        identity.vector_fields.fields.velocity.files.X_umap = 'vectors/0_1.bin.gz';
      },
      /files\.X_umap must be exactly "vectors\/0_1\.bin"/,
    ],
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, async t => {
      const id = `cross-path-compression-${name.replaceAll(/[ .]/g, '-')}`;
      const identity = createExportIdentity(id);
      mutate(identity);
      const remoteError = rejectedRemotely(id, identity);
      const localError = await rejectedLocally(t, id, identity);
      assert.match(String(remoteError), pattern);
      assert.match(String(localError), pattern);
    });
  }

  assert.equal(identityPayloadCompression(createExportIdentity('a')), null);
  const withoutSettings = createExportIdentity('b');
  delete withoutSettings.export_settings;
  assert.equal(identityPayloadCompression(withoutSettings), null);
  const compressed = createExportIdentity('c');
  compressed.export_settings.compression = 6;
  assert.equal(identityPayloadCompression(compressed), 6);
  assert.equal(embeddingPayloadPath(1, 2, 6), 'embeddings/1_2d.bin.gz');
  assert.equal(embeddingPayloadPath(0, 3, null), 'embeddings/0_3d.bin');
  assert.equal(vectorPayloadPath(2, 1, 6), 'vectors/2_1.bin.gz');
  assert.equal(vectorPayloadPath(0, 4, null), 'vectors/0_4.bin');

  // The local reader still requires the obs manifest to agree with the
  // export's declared compression.
  const mismatched = createExportIdentity('cross-path-obs-compression');
  const obsManifest = createObsManifest();
  obsManifest.compression = 6;
  const localError = await rejectedLocally(
    t,
    'cross-path-obs-compression',
    mismatched,
    obsManifest
  );
  assert.notEqual(localError, null);
});

test('both readers answer the same way about embeddings', async t => {
  const cases = [
    [
      'items out of (dimension, id) order',
      identity => {
        const { X_pca, X_umap } = identity.embeddings.items;
        identity.embeddings.items = {
          X_umap: { ...X_umap, file: 'embeddings/0_2d.bin' },
          X_pca: { ...X_pca, file: 'embeddings/1_2d.bin' },
        };
      },
      /ordered by dimension, then id in code-point order/,
    ],
    [
      'a defaults slot naming a missing item',
      identity => {
        identity.embeddings.defaults['2d'] = 'X_tsne';
      },
      /embeddings\.defaults\.2d must name an item of that dimension/,
    ],
    [
      'a defaults slot for a dimension no item has',
      identity => {
        identity.embeddings.defaults['3d'] = 'X_umap';
      },
      /defaults must name exactly one item per embedding dimension/,
    ],
    [
      'a default_dimension no default names',
      identity => {
        identity.embeddings.default_dimension = 3;
      },
      /default_dimension must be a dimension named in embeddings\.defaults/,
    ],
    [
      'source columns that do not match the dimension',
      identity => {
        identity.embeddings.items.X_pca.source.columns = [0, 1, 2];
      },
      /source\.columns must be 2 distinct 0-based column indices/,
    ],
    [
      'a version-2 embeddings block',
      identity => {
        identity.embeddings = {
          available_dimensions: [2],
          default_dimension: 2,
          files: { '2d': 'points_2d.bin' },
        };
      },
      /missing required field 'defaults'|unsupported field 'available_dimensions'/,
    ],
    [
      'version 2',
      identity => {
        identity.version = 2;
      },
      /Unsupported dataset_identity\.json version: 2\. Supported versions: 3/,
    ],
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, async t => {
      const id = `cross-path-embeddings-${name.replaceAll(/[ ,()]/g, '-')}`;
      const identity = createExportIdentity(id);
      mutate(identity);
      const remoteError = rejectedRemotely(id, identity);
      const localError = await rejectedLocally(t, id, identity);
      assert.match(String(remoteError), pattern);
      assert.match(String(localError), pattern);
    });
  }
});

test('the centroid embeddings must be identity items of the matching dimension on every reader', async t => {
  const cases = [
    [
      'centroids for an embedding the identity does not declare',
      manifest => {
        manifest._categoricalFields[0][5] = {
          ...manifest._categoricalFields[0][5],
          X_tsne: [],
        };
      },
      /centroids for embedding "X_tsne", which dataset_identity\.json does not declare/,
    ],
    [
      'centroid positions of the wrong dimension',
      manifest => {
        manifest._categoricalFields[0][5].X_umap = [
          { category: 'A', position: [-1, -1, 0], n_points: 1 },
        ];
      },
      /centroids for "X_umap" must have 2 coordinates/,
    ],
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, async t => {
      const id = `cross-path-centroids-${name.replaceAll(' ', '-')}`;
      const identity = createExportIdentity(id);
      const manifest = createObsManifest();
      mutate(manifest);
      // The hosted path checks the expanded manifest in the generation
      // contract; the local path checks it while staging the folder.
      assert.throws(
        () => validateDatasetGeneration({
          expectedIdentityId: id,
          identity,
          obsManifest: expandObsManifest(manifest),
          varManifest: null,
          connectivityManifest: null,
        }),
        pattern
      );
      const localError = await rejectedLocally(t, id, identity, manifest);
      assert.match(String(localError), pattern);
    });
  }
});

test('both readers answer the same way about vector_fields', async t => {
  // The rule lives in exactly one function, so a case that fails one reader
  // must fail the other, and the runtime manager — which reads the same
  // identity — must refuse it too. Only payload checks (the file length)
  // belong to the local reader alone.
  const cases = [
    [
      'a label that is not the field id',
      identity => {
        identity.vector_fields.fields.velocity.label = 'Velocity (UMAP)';
      },
      /label must be the field id "velocity" exactly/,
    ],
    [
      // The version-3 form of "a dimension the dataset has no points file
      // for": a field cannot be bound to an embedding the export lacks.
      'a files key naming no declared embedding',
      identity => {
        identity.vector_fields.fields.velocity.files = {
          X_tsne: 'vectors/0_2.bin',
        };
      },
      /binds embedding "X_tsne", which embeddings\.items does not declare/,
    ],
    [
      'a dimension slot instead of an embedding id',
      identity => {
        identity.vector_fields.fields.velocity.files = {
          '2d': 'vectors/0_1.bin',
        };
      },
      /binds embedding "2d", which embeddings\.items does not declare/,
    ],
    [
      'files out of item order',
      identity => {
        identity.vector_fields.fields.velocity.files = {
          X_umap: 'vectors/0_1.bin',
          X_pca: 'vectors/0_0.bin',
        };
      },
      /must list its embeddings in embeddings\.items order/,
    ],
    [
      'a path other than the exact producer path',
      identity => {
        identity.vector_fields.fields.velocity.files.X_umap = 'vectors/0_2d.bin';
      },
      /files\.X_umap must be exactly "vectors\/0_1\.bin"/,
    ],
    [
      'fields out of code-point order',
      identity => {
        identity.vector_fields.fields = {
          velocity: identity.vector_fields.fields.velocity,
          drift: { label: 'drift', files: { X_umap: 'vectors/1_1.bin' } },
        };
      },
      /fields must be ordered by id in code-point order/,
    ],
    [
      'an empty files map',
      identity => {
        identity.vector_fields.fields.velocity.files = {};
      },
      /files must be a non-empty object/,
    ],
    [
      'a version-2 basis key',
      identity => {
        identity.vector_fields.fields.velocity.basis = 'umap';
      },
      /unsupported field 'basis'/,
    ],
    [
      'a version-2 available_dimensions key',
      identity => {
        identity.vector_fields.fields.velocity.available_dimensions = [2];
      },
      /unsupported field 'available_dimensions'/,
    ],
    [
      'an obsm_keys path map instead of files',
      identity => {
        const field = identity.vector_fields.fields.velocity;
        delete field.files;
        field.obsm_keys = { X_umap: 'velocity_umap_2d' };
      },
      /missing required field 'files'/,
    ],
    [
      'a default_field naming no declared field',
      identity => {
        identity.vector_fields.default_field = 'absent';
      },
      /must be null or name a declared field/,
    ],
  ];

  for (const [name, mutate, pattern] of cases) {
    await t.test(name, async t => {
      const id = `cross-path-vector-${name.replaceAll(/[ ,()-]/g, '-')}`;
      const identity = createExportIdentity(id);
      mutate(identity);

      const remoteError = rejectedRemotely(id, identity);
      const localError = await rejectedLocally(t, id, identity);
      assert.notEqual(
        remoteError,
        null,
        'the hosted-catalog reader must reject this identity'
      );
      assert.notEqual(
        localError,
        null,
        'the local folder reader must reject the same identity'
      );
      assert.match(String(remoteError), pattern);
      assert.match(String(localError), pattern);
      // The runtime manager's vector fields are resolved from the very same
      // identity, so it cannot be the one reader that lets a rejected dataset
      // through. The mapping is the unmutated identity's, so the identity
      // rule is what refuses.
      assert.throws(
        () => resolveVectorFields({
          identity,
          mapping: resolveExportDataMapping(createExportIdentity(id), null),
          candidates: null,
          dimensionManager: dimensionManagerFor(createExportIdentity(id)),
        }),
        pattern
      );
    });
  }
});

test('the vector_fields rule has exactly one implementation', () => {
  // A single exported function, reachable from every reader, is what keeps the
  // paths from drifting apart again.
  assert.equal(typeof validateVectorFieldsMetadata, 'function');
  const identity = createExportIdentity('rule-owner');
  const accepted = identity.vector_fields;
  assert.equal(
    validateVectorFieldsMetadata(accepted, {
      embeddingItems: identity.embeddings.items,
      compression: null,
      sourceType: 'contract',
    }),
    accepted
  );
  // The rule cannot be applied without the embeddings and the compression it
  // binds to, so there is no partial mode that skips them.
  for (const options of [
    undefined,
    {},
    { sourceType: 'contract' },
    { embeddingItems: identity.embeddings.items },
    { compression: null },
    { embeddingItems: identity.embeddings.items, compression: '6' },
  ]) {
    assert.throws(
      () => validateVectorFieldsMetadata(accepted, options),
      /requires the identity embedding items and its compression/
    );
  }
  // The compression is part of the rule: the same field is wrong for a
  // compressed export.
  assert.throws(
    () => validateVectorFieldsMetadata(accepted, {
      embeddingItems: identity.embeddings.items,
      compression: 6,
    }),
    /files\.X_umap must be exactly "vectors\/0_1\.bin\.gz"/
  );
});

test('direct H5AD/Zarr, prepared-export, and Python-served identities share one v3 shape', async t => {
  const prepared = createExportIdentity('cross-path-prepared');
  const preparedCompressed = createExportIdentity('cross-path-prepared-gz');
  preparedCompressed.export_settings.compression = 6;
  for (const item of Object.values(preparedCompressed.embeddings.items)) {
    item.file += '.gz';
  }
  preparedCompressed.vector_fields.fields.velocity.files.X_umap += '.gz';
  const direct = {
    h5ad: await createDirectIdentity('h5ad'),
    zarr: await createDirectIdentity('zarr'),
  };
  const served = structuredClone(SERVED_IDENTITY);

  const producers = [
    ['prepared export', prepared, 'remote'],
    ['compressed prepared export', preparedCompressed, 'remote'],
    ['direct H5AD', direct.h5ad.identity, 'direct-anndata'],
    ['direct Zarr', direct.zarr.identity, 'direct-anndata'],
    ['Python-served AnnData', served, 'remote'],
  ];
  for (const [label, identity, sourceType] of producers) {
    await t.test(label, () => {
      assert.doesNotThrow(
        () => validateDatasetIdentity(identity, identity.id, sourceType)
      );
      assert.deepEqual(v3Shape(identity), V3_SHAPE);
      for (const key of Object.keys(identity)) {
        assert.ok(
          V3_SHAPE.requiredTopLevel.includes(key) ||
          OPTIONAL_TOP_LEVEL_KEYS.includes(key),
          `${label}: unexpected top-level key ${key}`
        );
      }
      assertV3Rules(identity, label);
    });
  }

  // Neither AnnData path is an export: it records no export_settings, so its
  // payload paths are uncompressed.
  for (const identity of [direct.h5ad.identity, direct.zarr.identity, served]) {
    assert.equal(Object.hasOwn(identity, 'export_settings'), false);
    assert.equal(identityPayloadCompression(identity), null);
  }

  // The browser and the Python server read one AnnData with one rule: the
  // same embedding ids, defaults, provenance, files, vector bindings, and
  // labels, character for character.
  for (const format of ['h5ad', 'zarr']) {
    const identity = direct[format].identity;
    assert.deepEqual(identity.embeddings, served.embeddings, `${format} embeddings`);
    assert.deepEqual(identity.vector_fields, served.vector_fields, `${format} vectors`);
    assert.deepEqual(identity.obs_fields, served.obs_fields, `${format} obs_fields`);
    assert.deepEqual(identity.stats, served.stats, `${format} stats`);
  }

  // Every path passes the whole generation contract with its own obs
  // manifest, including the centroidsByEmbedding cross-check.
  const generations = [
    [prepared, createObsManifest()],
    [served, SERVED_OBS_MANIFEST],
    [direct.h5ad.identity, direct.h5ad.adapter.getObsManifest()],
    [direct.zarr.identity, direct.zarr.adapter.getObsManifest()],
  ];
  for (const [identity, obsManifest] of generations) {
    assert.equal(obsManifest._format, 'compact_v2');
    const expanded = expandObsManifest(structuredClone(obsManifest));
    for (const field of expanded.fields) {
      if (field.kind !== 'category') continue;
      for (const embeddingId of Object.keys(field.centroidsByEmbedding)) {
        assert.ok(Object.hasOwn(identity.embeddings.items, embeddingId));
      }
    }
    assert.doesNotThrow(() => validateDatasetGeneration({
      expectedIdentityId: identity.id,
      identity,
      obsManifest: expanded,
      varManifest: null,
      connectivityManifest: null,
    }));
  }

  // The local folder reader publishes the prepared identity unchanged.
  const local = await loadLocally(t, prepared.id, prepared);
  assert.deepEqual(local.embeddings, prepared.embeddings);
  assert.deepEqual(local.vector_fields, prepared.vector_fields);
  assertV3Rules(local, 'local folder');

  // The direct vector field is called `<field>_umap`, never a display name,
  // whether it is read from the identity the adapter publishes or, as the
  // viewer reads a direct AnnData file, through the mapping routes of its
  // default data mapping.
  const directFields = [{
    id: 'velocity_umap',
    label: 'velocity_umap',
    layoutKeys: ['X_umap_2d', 'X_umap_3d'],
  }];
  assert.deepEqual(vectorManagerFor(direct.h5ad.identity).getAvailableFields(), directFields);
  const candidates = direct.h5ad.adapter.getMappingCandidates();
  const directDimensions = dimensionManagerFor(direct.h5ad.identity);
  const mapped = resolveVectorFields({
    identity: direct.h5ad.identity,
    mapping: candidates.defaults,
    candidates,
    dimensionManager: directDimensions,
  });
  const routes = Object.values(mapped.fields.get('velocity_umap').files);
  assert.ok(routes.every(route => route.startsWith('_cellucid/mapping/vectors/')));
  assert.deepEqual(
    new VectorFieldManager({
      baseUrl: 'h5ad://direct-h5ad-cross-path/',
      vectorFields: mapped,
      dimensionManager: directDimensions,
    }).getAvailableFields(),
    directFields
  );
});
