import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateDatasetIdentity,
  validateVectorFieldsMetadata,
} from '../assets/js/data/data-source.js';
import {
  LocalUserDirDataSource,
} from '../assets/js/data/local-user-source.js';
import {
  VectorFieldManager,
} from '../assets/js/data/vector-field-manager.js';

// One export, two readers.
//
// The on-disk export format is a contract between five repositories, and the
// web app reads the same directory two ways: over HTTP from a catalog, and
// straight out of a folder the user picked. Whenever those two readers disagree
// about what a manifest may contain, a spec-conformant third-party export loads
// from one and is rejected by the other. Every case below therefore feeds the
// *same* fixture to both paths and asserts they answer identically.

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
 * One complete, spec-conformant export identity: uncompressed, unquantized,
 * two obs fields, one vector field on the producer's exact payload path.
 */
function createExportIdentity(id) {
  return {
    version: 2,
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
      available_dimensions: [2],
      default_dimension: 2,
      files: { '2d': 'points_2d.bin' },
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
      default_field: 'velocity_umap',
      fields: {
        velocity_umap: {
          label: 'velocity_umap',
          basis: 'umap',
          available_dimensions: [2],
          default_dimension: 2,
          files: { '2d': 'vectors/0_2d.bin' },
        },
      },
    },
  };
}

function createObsManifest() {
  return {
    _format: 'compact_v1',
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
      { '2': [] },
    ]],
  };
}

function createExportDirectory(id, identity) {
  return [
    createFile(
      `${id}/dataset_identity.json`,
      JSON.stringify(identity)
    ),
    createFile(
      `${id}/obs_manifest.json`,
      JSON.stringify(createObsManifest())
    ),
    createFile(
      `${id}/points_2d.bin`,
      float32Bytes([0, 0, 1, 0, 0, 1])
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
      `${id}/vectors/0_2d.bin`,
      float32Bytes([0.1, 0, 0.2, 0, 0.3, 0])
    ),
  ];
}

async function loadLocally(t, id, identity) {
  const source = new LocalUserDirDataSource();
  t.after(() => source.clear());
  return source.loadFromPreparedDirectory(
    createExportDirectory(id, identity)
  );
}

async function rejectedLocally(t, id, identity) {
  const source = new LocalUserDirDataSource();
  t.after(() => source.clear());
  try {
    await source.loadFromPreparedDirectory(
      createExportDirectory(id, identity)
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

test('the optional identity keys are optional on every reader', async t => {
  // created_at and export_settings are the only optional top-level keys of
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
    });
  }
});

test('compression comes from the required manifests, not the optional block', async t => {
  // obs_manifest.json is required and declares its own compression, which
  // expandObsManifest() has already matched against every path pattern it
  // carries. That makes it the export's compression, so path resolution never
  // depends on export_settings being present.
  const id = 'cross-path-derived-compression';
  const identity = createExportIdentity(id);
  delete identity.export_settings;
  identity.embeddings.files['2d'] = 'points_2d.bin.gz';

  const remoteError = rejectedRemotely(id, identity);
  const localError = await rejectedLocally(t, id, identity);
  assert.equal(
    remoteError,
    null,
    'a .gz path is a well-formed identity on its own'
  );
  assert.match(
    String(localError),
    /must not end in \.gz/,
    'the local reader still catches mixed compression without export_settings'
  );
});

test('both readers answer the same way about vector_fields', async t => {
  // The rule lives in exactly one function, so a case that fails one reader
  // must fail the other. Only export-file rules (the producer path string, the
  // payload length) belong to the local reader alone.
  const cases = [
    [
      'default_dimension below the largest advertised dimension',
      identity => {
        identity.embeddings.available_dimensions = [2, 3];
        identity.embeddings.files['3d'] = 'points_3d.bin';
        const field = identity.vector_fields.fields.velocity_umap;
        field.available_dimensions = [2, 3];
        field.default_dimension = 2;
        field.files['3d'] = 'vectors/0_3d.bin';
      },
      /default_dimension must be the largest advertised dimension/,
    ],
    [
      'a dimension the dataset has no points file for',
      identity => {
        const field = identity.vector_fields.fields.velocity_umap;
        field.available_dimensions = [2, 3];
        field.default_dimension = 3;
        field.files['3d'] = 'vectors/0_3d.bin';
      },
      /must be a subset of embeddings\.available_dimensions/,
      // The runtime manager is handed vector_fields alone and has no
      // embeddings context, so this one rule is checked where the embeddings
      // are — in the identity validator both readers already run.
      { manager: false },
    ],
    [
      'an obsm_keys path map instead of files',
      identity => {
        const field = identity.vector_fields.fields.velocity_umap;
        delete field.files;
        field.obsm_keys = { '2d': 'velocity_umap_2d' };
      },
      /missing required field 'files'/,
    ],
    [
      'a files entry with no matching advertised dimension',
      identity => {
        identity.vector_fields.fields.velocity_umap.files['3d'] =
          'vectors/0_3d.bin';
      },
      /exactly one path per advertised dimension/,
    ],
    [
      'a default_field naming no declared field',
      identity => {
        identity.vector_fields.default_field = 'absent_umap';
      },
      /must be null or name a declared field/,
    ],
  ];

  for (const [name, mutate, pattern, options = {}] of cases) {
    await t.test(name, async t => {
      const id = `cross-path-vector-${name.replaceAll(' ', '-')}`;
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
      // The runtime manager consumes the very same metadata object, so it
      // cannot be the one reader that lets a rejected dataset through.
      if (options.manager !== false) {
        assert.throws(
          () => new VectorFieldManager({
            baseUrl: 'https://example.test/dataset/',
            vectorFieldsMetadata: identity.vector_fields,
            dimensionManager: {
              async getPositions3D() {
                return new Float32Array(N_CELLS * 3);
              },
              getNormTransform() {
                return { center: [0, 0, 0], scale: 1 };
              },
            },
          }),
          pattern
        );
      }
    });
  }
});

test('the vector_fields rule has exactly one implementation', () => {
  // A single exported function, reachable from every reader, is what keeps the
  // three paths from drifting apart again.
  assert.equal(typeof validateVectorFieldsMetadata, 'function');
  const accepted = createExportIdentity('rule-owner').vector_fields;
  assert.equal(
    validateVectorFieldsMetadata(accepted, {
      availableDimensions: [2],
      sourceType: 'contract',
    }),
    accepted
  );
  // Without an embeddings context the subset rule is simply not checked; every
  // other rule still applies.
  assert.equal(
    validateVectorFieldsMetadata(accepted, { sourceType: 'contract' }),
    accepted
  );
});
