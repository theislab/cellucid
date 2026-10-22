import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { getDataSourceManager } from '../assets/js/data/data-source-manager.js';
import {
  ANNDATA_KIND,
  EXPORT_KIND,
  sortVectorBindings,
  validateDataMapping,
} from '../assets/js/data/data-mapping.js';
import {
  assembleAnnDataCandidates,
  describeAnnDataProbes,
  resolveVectorBinding,
} from '../assets/js/data/data-mapping-candidates.js';
import {
  VectorFieldManager,
  createVectorFieldManager,
  resolveVectorFields,
} from '../assets/js/data/vector-field-manager.js';
import { mappingProbes } from './helpers/anndata-mapping-mocks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const UMAP_ITEMS = Object.freeze({
  X_umap: {
    label: 'UMAP',
    dimension: 2,
    file: 'embeddings/0_2d.bin',
    source: { key: 'X_umap', columns: [0, 1] },
  },
});

// Several embeddings per dimension: item order is (dimension, id), and an
// item's position in that order is its payload index.
const MULTI_ITEMS = Object.freeze({
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
  X_umap_3d: {
    label: 'X_umap_3d',
    dimension: 3,
    file: 'embeddings/2_3d.bin',
    source: { key: null, columns: [0, 1, 2] },
  },
});

/**
 * The parts of a version-3 dataset identity the vector manager reads:
 * `embeddings.items`, `export_settings.compression` (absent = uncompressed),
 * and `vector_fields` (absent = no vectors).
 */
function identity(vectorFields, { items = UMAP_ITEMS, compression } = {}) {
  const value = {
    version: 3,
    embeddings: {
      default_dimension: 2,
      defaults: { '2d': 'X_umap' },
      items,
    },
  };
  if (compression !== undefined) {
    value.export_settings = {
      compression,
      var_quantization: null,
      obs_continuous_quantization: null,
      obs_categorical_dtype: 'uint8',
    };
  }
  if (vectorFields !== undefined) {
    value.vector_fields = vectorFields;
  }
  return value;
}

function dimensionManager({
  // Two cells of a 2D embedding: two components each.
  positions = new Float32Array([0, 0, 1, 1]),
  scale = 2,
  items = UMAP_ITEMS,
  positionsByLayout = null,
} = {}) {
  // Every embedding item is a registered layout keyed by its embedding id; a
  // vector payload is bound to the layout of the embedding it names.
  const requireLayout = (layoutKey) => {
    assert.ok(Object.hasOwn(items, layoutKey), `unexpected layout ${layoutKey}`);
    return layoutKey;
  };
  return {
    async getPositions(layoutKey) {
      requireLayout(layoutKey);
      return positionsByLayout?.[layoutKey] ?? positions;
    },
    getNormTransform(layoutKey) {
      requireLayout(layoutKey);
      return { center: [0, 0, 0], scale };
    },
    hasLayout(layoutKey) {
      return Object.hasOwn(items, layoutKey);
    },
    getLayout(layoutKey) {
      requireLayout(layoutKey);
      return { layoutKey, dimension: items[layoutKey].dimension };
    },
    // The registered layout an AnnData `obsm` reference plots, by the
    // provenance its item records; null when none does.
    resolveProvenanceLayout(key, columns) {
      const match = Object.entries(items).find(([, item]) => (
        item.source.key === key &&
        item.source.columns.join(',') === columns.join(',')
      ));
      return match === undefined ? null : match[0];
    },
  };
}

function field(fieldId, files) {
  return { label: fieldId, files };
}

function metadata(defaultField = null) {
  return {
    default_field: defaultField,
    fields: {
      alpha_umap: field('alpha_umap', { X_umap: 'vectors/0_0.bin' }),
      beta_umap: field('beta_umap', { X_umap: 'vectors/1_0.bin' }),
    },
  };
}

/**
 * The export mapping that uses every binding an identity declares, as
 * `resolveExportDataMapping()` builds it. It reads the declaration
 * defensively, so a malformed `vector_fields` reaches the identity validator
 * inside `resolveVectorFields()`, which is the rule under test.
 */
function exportMapping(identityValue, { only = null } = {}) {
  const fields = identityValue.vector_fields?.fields;
  const bindings = [];
  for (const [fieldId, entry] of Object.entries(fields ?? {})) {
    const files = entry?.files;
    if (files === null || typeof files !== 'object') continue;
    for (const embeddingId of Object.keys(files)) {
      if (only !== null && !only.some(([f, e]) => f === fieldId && e === embeddingId)) continue;
      bindings.push({ field: fieldId, embedding: { key: embeddingId, columns: null } });
    }
  }
  // Every bound embedding is enabled, beside the 2D default.
  const enabledKeys = [...new Set(['X_umap', ...bindings.map(binding => binding.embedding.key)])]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return validateDataMapping({
    kind: EXPORT_KIND,
    embeddings: {
      enabled: enabledKeys.map(key => ({ key, columns: null })),
      defaults: { '1d': null, '2d': { key: 'X_umap', columns: null }, '3d': null },
    },
    geneNames: 'index',
    vectorFields: sortVectorBindings(bindings, EXPORT_KIND),
  });
}

function managerOptions(vectorFields, overrides = {}) {
  const { items = UMAP_ITEMS, compression, ...rest } = overrides;
  const identityValue = identity(vectorFields, { items, compression });
  const manager = dimensionManager({ items });
  return {
    baseUrl: 'https://example.test/dataset/',
    vectorFields: resolveVectorFields({
      identity: identityValue,
      mapping: exportMapping(identityValue),
      candidates: null,
      dimensionManager: manager,
    }),
    dimensionManager: manager,
    ...rest,
  };
}

/**
 * An AnnData file with `X_umap` (obsm 0) and `velocity_umap_2d` (obsm 1) of
 * two cells, shown with its default mapping: `velocity_umap_2d` is bound to
 * `X_umap` columns [0, 1], whose layout is `X_umap`.
 */
function directCandidates(obsm = { X_umap: 2, velocity_umap_2d: 2 }) {
  return assembleAnnDataCandidates(
    describeAnnDataProbes(mappingProbes({ nObs: 2, obsm })),
    { slots: { '1d': null, '2d': { key: 'X_umap', columns: [0, 1] }, '3d': null }, guessed: [] }
  );
}

const DIRECT_VECTOR_ROUTE = '_cellucid/mapping/vectors/1/0-1/0/0-1.bin';

function directManagerOptions(baseUrl) {
  const candidates = directCandidates();
  const manager = dimensionManager();
  return {
    baseUrl,
    vectorFields: resolveVectorFields({
      identity: null,
      mapping: candidates.defaults,
      candidates,
      dimensionManager: manager,
    }),
    dimensionManager: manager,
  };
}

test('vector metadata preserves an explicit nullable default without first-field selection', () => {
  const manager = createVectorFieldManager(managerOptions(metadata(null)));

  assert.equal(manager.hasAny(), true);
  assert.equal(manager.getDefaultFieldId(), null);
  assert.deepEqual(manager.getAvailableFields(), [
    {
      id: 'alpha_umap',
      label: 'alpha_umap',
      layoutKeys: ['X_umap'],
    },
    {
      id: 'beta_umap',
      label: 'beta_umap',
      layoutKeys: ['X_umap'],
    },
  ]);
  assert.equal(manager.hasField('alpha_umap'), true);
  assert.equal(manager.hasField('missing_umap'), false);
  assert.equal(manager.hasFieldLayout('alpha_umap', 'X_umap'), true);
  // A dimension name is not a layout key.
  assert.equal(manager.hasFieldLayout('alpha_umap', '2d'), false);
  assert.equal(manager.hasFieldLayout('alpha_umap', 'X_umap_3d'), false);
  // A second layout of the same dimension has no binding of its own.
  assert.equal(manager.hasFieldLayout('alpha_umap', 'tsne'), false);
  assert.throws(() => manager.hasField(7), /non-empty string/);
  assert.throws(
    () => manager.hasFieldLayout('alpha_umap', 2),
    /layoutKey must be a non-empty string/
  );

  // A named default leads the list; the rest stay in id order.
  const withDefault = createVectorFieldManager(managerOptions(metadata('beta_umap')));
  assert.equal(withDefault.getDefaultFieldId(), 'beta_umap');
  assert.deepEqual(
    withDefault.getAvailableFields().map(({ id }) => id),
    ['beta_umap', 'alpha_umap']
  );

  // An identity without vector_fields has no field and no default.
  const none = createVectorFieldManager(managerOptions(undefined));
  assert.equal(none.hasAny(), false);
  assert.equal(none.getDefaultFieldId(), null);
  assert.deepEqual(none.getAvailableFields(), []);
});

test('vector bindings come from files keys: one payload per bound embedding, several per dimension', () => {
  const vectorFields = {
    default_field: 'velocity',
    fields: {
      velocity: field('velocity', {
        X_umap: 'vectors/0_1.bin',
        X_umap_3d: 'vectors/0_2.bin',
      }),
    },
  };
  const manager = createVectorFieldManager(
    managerOptions(vectorFields, { items: MULTI_ITEMS })
  );
  assert.deepEqual(manager.getAvailableFields(), [{
    id: 'velocity',
    label: 'velocity',
    layoutKeys: ['X_umap', 'X_umap_3d'],
  }]);
  assert.equal(manager.hasFieldLayout('velocity', 'X_umap'), true);
  assert.equal(manager.hasFieldLayout('velocity', 'X_umap_3d'), true);
  // X_pca is a registered 2D layout, but the field is not bound to it.
  assert.equal(manager.hasFieldLayout('velocity', 'X_pca'), false);
  assert.ok(Object.isFrozen(manager.getAvailableFields()[0]));
  assert.ok(Object.isFrozen(manager.getAvailableFields()[0].layoutKeys));
});

test('vector manager requires the sole exact constructor and metadata shape', () => {
  assert.throws(
    () => new VectorFieldManager(),
    /plain object/
  );
  assert.throws(
    () => new VectorFieldManager({
      ...managerOptions(undefined),
      legacyMetadata: {},
    }),
    /unsupported key "legacyMetadata"/
  );
  // The version-2 option that carried bare vector metadata is gone, and so
  // is the identity: the manager takes only the vector fields the data
  // mapping uses, resolved by resolveVectorFields().
  assert.throws(
    () => new VectorFieldManager({
      baseUrl: 'https://example.test/dataset/',
      vectorFieldsMetadata: metadata(null),
      dimensionManager: dimensionManager(),
    }),
    /unsupported key "vectorFieldsMetadata"/
  );
  assert.throws(
    () => new VectorFieldManager({
      baseUrl: 'https://example.test/dataset/',
      identity: identity(metadata(null)),
      dimensionManager: dimensionManager(),
    }),
    /unsupported key "identity"/
  );
  {
    const { vectorFields: _vectorFields, ...withoutVectorFields } = managerOptions(undefined);
    assert.throws(
      () => new VectorFieldManager(withoutVectorFields),
      /vectorFields/
    );
  }
  // A raw identity `vector_fields` block, or a default naming no listed
  // field, is not a resolved vector-field set.
  for (const vectorFields of [
    metadata(null),
    { defaultField: null, fields: { alpha_umap: field('alpha_umap', { X_umap: 'vectors/0_0.bin' }) } },
    { defaultField: 'missing_umap', fields: new Map() },
    null,
  ]) {
    assert.throws(
      () => new VectorFieldManager({ ...managerOptions(undefined), vectorFields }),
      /vectorFields must come from resolveVectorFields\(\)/
    );
  }
  assert.throws(
    () => new VectorFieldManager({
      ...managerOptions(undefined),
      baseUrl: 'https://example.test/dataset',
    }),
    /ending in/
  );
  assert.throws(
    () => {
      const bare = { version: 3, embeddings: { default_dimension: 2, defaults: {} } };
      return resolveVectorFields({
        identity: bare,
        mapping: exportMapping(bare),
        candidates: null,
        dimensionManager: dimensionManager(),
      });
    },
    /dataset identity with embedding items/
  );
  // The dimension manager must be able to say which layouts exist.
  const { hasLayout: _hasLayout, ...withoutHasLayout } = dimensionManager();
  assert.throws(
    () => new VectorFieldManager({
      ...managerOptions(metadata(null)),
      dimensionManager: withoutHasLayout,
    }),
    /must provide getPositions\(\), getNormTransform\(\), getLayout\(\), and hasLayout\(\)/
  );
  assert.throws(
    () => new VectorFieldManager(managerOptions({
      default_field: 'missing_umap',
      fields: {
        alpha_umap: field('alpha_umap', { X_umap: 'vectors/0_0.bin' }),
      },
    })),
    /null or name a declared field/
  );
  assert.throws(
    () => new VectorFieldManager(managerOptions({
      default_field: null,
      fields: {
        alpha_umap: {
          ...field('alpha_umap', { X_umap: 'vectors/0_0.bin' }),
          components: { X_umap: 2 },
        },
      },
    })),
    /unsupported field 'components'/
  );
  // The version-2 per-field keys have no place in a version-3 field entry:
  // the bound embedding says which dimension a payload has.
  for (const removed of ['basis', 'available_dimensions', 'default_dimension']) {
    assert.throws(
      () => new VectorFieldManager(managerOptions({
        default_field: null,
        fields: {
          alpha_umap: {
            ...field('alpha_umap', { X_umap: 'vectors/0_0.bin' }),
            [removed]: removed === 'basis' ? 'umap' : 2,
          },
        },
      })),
      new RegExp(`unsupported field '${removed}'`)
    );
  }
  // "files" is the only path map the format has. An `obsm_keys` entry is not a
  // looser alternative spelling of it: an AnnData file's vectors are read
  // through mapping routes, never through an identity path map.
  assert.throws(
    () => new VectorFieldManager(managerOptions({
      default_field: null,
      fields: {
        alpha_umap: {
          label: 'alpha_umap',
          obsm_keys: { X_umap: 'alpha_umap_2d' },
        },
      },
    })),
    /missing required field 'files'/
  );
  // The label is derived, never chosen: it is the field id exactly.
  assert.throws(
    () => new VectorFieldManager(managerOptions({
      default_field: null,
      fields: {
        velocity_umap: {
          label: 'Velocity (UMAP)',
          files: { X_umap: 'vectors/0_0.bin' },
        },
      },
    })),
    /label must be the field id "velocity_umap" exactly/
  );
  // Field ids are listed in code-point order, and that order is the field
  // index every vector path carries.
  assert.throws(
    () => new VectorFieldManager(managerOptions({
      default_field: null,
      fields: {
        beta_umap: field('beta_umap', { X_umap: 'vectors/0_0.bin' }),
        alpha_umap: field('alpha_umap', { X_umap: 'vectors/1_0.bin' }),
      },
    })),
    /fields must be ordered by id in code-point order/
  );
});

test('vector files must bind declared embeddings, in item order, at the exact producer path', () => {
  const reject = (files, pattern, extra = {}) => assert.throws(
    () => new VectorFieldManager(managerOptions({
      default_field: null,
      fields: { velocity: field('velocity', files) },
    }, { items: MULTI_ITEMS, ...extra })),
    pattern
  );
  // A field cannot be bound to an embedding the export does not carry; this
  // is the version-3 form of "a files entry with no matching dimension".
  reject(
    { X_tsne: 'vectors/0_0.bin' },
    /binds embedding "X_tsne", which embeddings\.items does not declare/
  );
  reject({ '2d': 'vectors/0_1.bin' }, /binds embedding "2d"/);
  reject({}, /files must be a non-empty object/);
  reject(
    { X_umap_3d: 'vectors/0_2.bin', X_umap: 'vectors/0_1.bin' },
    /must list its embeddings in embeddings\.items order/
  );
  // The path is the producer rule's exact string, nothing that merely
  // resolves to a file.
  for (const wrong of [
    'vectors/0_0.bin',
    'vectors/velocity_1.bin',
    'vectors/0_2d.bin',
    './vectors/0_1.bin',
    'vectors/0_1.bin.gz',
  ]) {
    reject({ X_umap: wrong }, /files\.X_umap must be exactly "vectors\/0_1\.bin"/);
  }
  // A compressed export's payloads carry `.gz`, and only then.
  reject(
    { X_umap: 'vectors/0_1.bin' },
    /files\.X_umap must be exactly "vectors\/0_1\.bin\.gz"/,
    { compression: 6 }
  );
  const compressed = new VectorFieldManager(managerOptions({
    default_field: null,
    fields: { velocity: field('velocity', { X_umap: 'vectors/0_1.bin.gz' }) },
  }, { items: MULTI_ITEMS, compression: 6 }));
  assert.equal(compressed.hasFieldLayout('velocity', 'X_umap'), true);
  const uncompressedSettings = new VectorFieldManager(managerOptions({
    default_field: null,
    fields: { velocity: field('velocity', { X_umap: 'vectors/0_1.bin' }) },
  }, { items: MULTI_ITEMS, compression: null }));
  assert.equal(uncompressedSettings.hasFieldLayout('velocity', 'X_umap'), true);

  // Every bound embedding must be a layout the dimension manager registered.
  assert.throws(
    () => new VectorFieldManager({
      ...managerOptions({
        default_field: null,
        fields: { velocity: field('velocity', { X_umap_3d: 'vectors/0_2.bin' }) },
      }, { items: MULTI_ITEMS }),
      dimensionManager: dimensionManager({ items: UMAP_ITEMS }),
    }),
    /bound to embedding "X_umap_3d", which the dimension manager has not registered/
  );
});

test('resolveVectorFields lists exactly the bindings the data mapping uses', () => {
  // A prepared export: the identity's validated fields, filtered to the
  // mapping's bindings. A default the mapping no longer uses is dropped.
  const declared = identity({
    default_field: 'velocity',
    fields: {
      drift: field('drift', { X_umap: 'vectors/0_1.bin' }),
      velocity: field('velocity', {
        X_umap: 'vectors/1_1.bin',
        X_umap_3d: 'vectors/1_2.bin',
      }),
    },
  }, { items: MULTI_ITEMS });
  const manager = dimensionManager({ items: MULTI_ITEMS });
  const all = resolveVectorFields({
    identity: declared,
    mapping: exportMapping(declared),
    candidates: null,
    dimensionManager: manager,
  });
  assert.equal(all.defaultField, 'velocity');
  assert.deepEqual([...all.fields.keys()], ['drift', 'velocity']);
  assert.deepEqual({ ...all.fields.get('velocity').files }, {
    X_umap: 'vectors/1_1.bin',
    X_umap_3d: 'vectors/1_2.bin',
  });
  const some = resolveVectorFields({
    identity: declared,
    mapping: exportMapping(declared, { only: [['drift', 'X_umap'], ['velocity', 'X_umap_3d']] }),
    candidates: null,
    dimensionManager: manager,
  });
  assert.equal(some.defaultField, 'velocity');
  assert.deepEqual({ ...some.fields.get('velocity').files }, { X_umap_3d: 'vectors/1_2.bin' });
  const driftOnly = resolveVectorFields({
    identity: declared,
    mapping: exportMapping(declared, { only: [['drift', 'X_umap']] }),
    candidates: null,
    dimensionManager: manager,
  });
  assert.equal(driftOnly.defaultField, null);
  assert.deepEqual([...driftOnly.fields.keys()], ['drift']);
  assert.ok(Object.isFrozen(driftOnly));
  assert.ok(Object.isFrozen(driftOnly.fields.get('drift').files));
  // The export path still applies the identity rule to what it reads.
  const malformed = identity({
    default_field: null,
    fields: { velocity: field('velocity', { X_umap: 'vectors/0_0.bin' }) },
  }, { items: MULTI_ITEMS });
  assert.throws(
    () => resolveVectorFields({
      identity: malformed,
      mapping: exportMapping(malformed),
      candidates: null,
      dimensionManager: manager,
    }),
    /files\.X_umap must be exactly "vectors\/0_1\.bin"/
  );

  // An AnnData file: each binding is read through its mapping route, under
  // the layout the dimension manager registers for its embedding, and the
  // route is exactly what resolveVectorBinding() names.
  const candidates = directCandidates();
  const direct = resolveVectorFields({
    identity: null,
    mapping: candidates.defaults,
    candidates,
    dimensionManager: dimensionManager(),
  });
  assert.equal(direct.defaultField, 'velocity_umap');
  assert.deepEqual({ ...direct.fields.get('velocity_umap') }, {
    label: 'velocity_umap',
    files: { X_umap: DIRECT_VECTOR_ROUTE },
  });
  assert.equal(
    resolveVectorBinding(candidates, candidates.defaults.vectorFields[0]).path,
    DIRECT_VECTOR_ROUTE
  );
  // Two fields: no default is chosen for the user.
  const twoFields = directCandidates({ X_umap: 2, alpha: 2, velocity_umap_2d: 2 });
  const twoMapping = validateDataMapping({
    ...twoFields.defaults,
    vectorFields: sortVectorBindings([
      { key: 'alpha', embedding: { key: 'X_umap', columns: [0, 1] } },
      { key: 'velocity_umap_2d', embedding: { key: 'X_umap', columns: [0, 1] } },
    ], ANNDATA_KIND),
  });
  const two = resolveVectorFields({
    identity: null,
    mapping: twoMapping,
    candidates: twoFields,
    dimensionManager: dimensionManager(),
  });
  assert.equal(two.defaultField, null);
  assert.deepEqual([...two.fields.keys()], ['alpha', 'velocity_umap']);
  // A binding that cannot be drawn is refused by name, never dropped.
  const narrow = directCandidates({ X_umap: 2, velocity_umap_2d: 3, wide: 5 });
  assert.throws(
    () => resolveVectorFields({
      identity: null,
      mapping: validateDataMapping({
        ...narrow.defaults,
        vectorFields: [{ key: 'wide', embedding: { key: 'X_umap', columns: [0, 1] } }],
      }),
      candidates: narrow,
      dimensionManager: dimensionManager(),
    }),
    /Vector field obsm\['wide'\] cannot be drawn: obsm\['wide'\] has 5 columns/
  );
  // Two arrays that are one field of the same layout are refused.
  const twin = directCandidates({ X_umap: 2, velocity_umap: 2, velocity_umap_2d: 2 });
  assert.throws(
    () => resolveVectorFields({
      identity: null,
      mapping: validateDataMapping({
        ...twin.defaults,
        vectorFields: sortVectorBindings([
          { key: 'velocity_umap', embedding: { key: 'X_umap', columns: [0, 1] } },
          { key: 'velocity_umap_2d', embedding: { key: 'X_umap', columns: [0, 1] } },
        ], ANNDATA_KIND),
      }),
      candidates: twin,
      dimensionManager: dimensionManager(),
    }),
    /Two vector arrays are the vector field "velocity_umap" of X_umap; bind only one\./
  );
  // A bound embedding no layout plots is refused.
  assert.throws(
    () => resolveVectorFields({
      identity: null,
      mapping: candidates.defaults,
      candidates,
      dimensionManager: { ...dimensionManager(), resolveProvenanceLayout: () => null },
    }),
    /bound to obsm\['X_umap'\], which cannot be plotted/
  );
});

test('a field is loaded per bound layout with that layout\'s own dimension and path', async () => {
  const dataSourceManager = getDataSourceManager();
  const previousSource = dataSourceManager.activeSource;
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  const payloads = [
    new Float32Array([1, 0, 0, 0, 2, 0]),
    new Float32Array([3, 4, 0, 0]),
  ];
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    const payload = payloads.shift();
    assert.ok(payload);
    return new Response(payload.buffer, {
      status: 200,
      headers: { 'content-length': String(payload.byteLength) },
    });
  };
  dataSourceManager.activeSource = null;
  try {
    const manager = new VectorFieldManager({
      ...managerOptions({
        default_field: 'velocity',
        fields: {
          velocity: field('velocity', {
            X_umap: 'vectors/0_1.bin',
            X_umap_3d: 'vectors/0_2.bin',
          }),
        },
      }, { items: MULTI_ITEMS }),
      dimensionManager: dimensionManager({
        items: MULTI_ITEMS,
        positionsByLayout: {
          X_umap: new Float32Array([0, 0, 1, 1]),
          X_umap_3d: new Float32Array([0, 0, 0, 1, 1, 1]),
        },
      }),
    });
    const threeD = await manager.loadField('velocity', 'X_umap_3d', {
      showProgress: false,
    });
    assert.equal(threeD.components, 3);
    assert.equal(threeD.cellCount, 2);
    assert.deepEqual(Array.from(threeD.vectors), [2, 0, 0, 0, 4, 0]);
    const twoD = await manager.loadField('velocity', 'X_umap', {
      showProgress: false,
    });
    assert.equal(twoD.components, 2);
    assert.equal(twoD.maxMagnitude, 10);
    assert.deepEqual(requestedUrls, [
      'https://example.test/dataset/vectors/0_2.bin',
      'https://example.test/dataset/vectors/0_1.bin',
    ]);
    await assert.rejects(
      manager.loadField('velocity', 'X_pca', { showProgress: false }),
      /field "velocity" declares no data for layout "X_pca"/
    );
    await assert.rejects(
      manager.loadField('missing', 'X_umap', { showProgress: false }),
      /unknown field "missing"/
    );
  } finally {
    globalThis.fetch = originalFetch;
    dataSourceManager.activeSource = previousSource;
  }
});

test('prepared vectors retain exact finite values, scale, and zero magnitude', async () => {
  const dataSourceManager = getDataSourceManager();
  const previousSource = dataSourceManager.activeSource;
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  const payloads = [
    new Float32Array([3, 4, 0, 0]),
    new Float32Array([0, 0, 0, 0]),
  ];
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    const payload = payloads.shift();
    assert.ok(payload);
    return new Response(payload.buffer, {
      status: 200,
      headers: { 'content-length': String(payload.byteLength) },
    });
  };
  dataSourceManager.activeSource = null;

  try {
    const manager = new VectorFieldManager(managerOptions(metadata(null)));
    const scaled = await manager.loadField(
      'alpha_umap',
      'X_umap',
      { showProgress: false }
    );
    assert.deepEqual(Array.from(scaled.vectors), [6, 8, 0, 0]);
    assert.equal(scaled.components, 2);
    assert.equal(scaled.cellCount, 2);
    assert.equal(scaled.maxMagnitude, 10);

    const zero = await manager.loadField(
      'beta_umap',
      'X_umap',
      { showProgress: false }
    );
    assert.deepEqual(Array.from(zero.vectors), [0, 0, 0, 0]);
    assert.equal(zero.maxMagnitude, 0);
    assert.deepEqual(requestedUrls, [
      'https://example.test/dataset/vectors/0_0.bin',
      'https://example.test/dataset/vectors/1_0.bin',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    dataSourceManager.activeSource = previousSource;
  }
});

test('disposing a vector manager aborts its in-flight download', async () => {
  const dataSourceManager = getDataSourceManager();
  const previousSource = dataSourceManager.activeSource;
  const originalFetch = globalThis.fetch;
  let fetchSignal = null;
  const fetchStarted = new Promise(resolve => {
    globalThis.fetch = (_url, init) => {
      fetchSignal = init?.signal ?? null;
      resolve();
      return new Promise((_resolve, reject) => {
        fetchSignal?.addEventListener('abort', () => reject(fetchSignal.reason), {
          once: true,
        });
      });
    };
  });
  dataSourceManager.activeSource = null;
  try {
    const manager = new VectorFieldManager(managerOptions(metadata(null)));
    const loading = manager.loadField('alpha_umap', 'X_umap', { showProgress: false });
    await fetchStarted;
    assert.ok(fetchSignal instanceof AbortSignal, 'the download must be abortable');
    manager.dispose();
    await assert.rejects(loading, error => error?.name === 'AbortError');
    assert.equal(fetchSignal.aborted, true);
    await assert.rejects(
      manager.loadField('beta_umap', 'X_umap', { showProgress: false }),
      error => error?.name === 'AbortError',
    );
  } finally {
    globalThis.fetch = originalFetch;
    dataSourceManager.activeSource = previousSource;
  }
});

test('vector normalization performs no per-cell temporary-array allocation', () => {
  const source = VectorFieldManager.prototype._loadExactField.toString();
  assert.doesNotMatch(source, /scaledComponents|Math\.hypot|\.\.\./);
  assert.match(source, /magnitudeSquared \+= scaled \* scaled/);
  assert.match(source, /Math\.sqrt\(maxMagnitudeSquared\)/);
});

test('non-finite vector payloads fail instead of being replaced', async () => {
  const dataSourceManager = getDataSourceManager();
  const previousSource = dataSourceManager.activeSource;
  const originalFetch = globalThis.fetch;
  dataSourceManager.activeSource = null;
  globalThis.fetch = async () => {
    const payload = new Float32Array([Number.NaN, 1, 2, 3]);
    return new Response(payload.buffer, {
      status: 200,
      headers: { 'content-length': String(payload.byteLength) },
    });
  };

  try {
    const manager = new VectorFieldManager(managerOptions(metadata(null)));
    // A fetched vector payload is now refused at the shared Float32 decode
    // boundary in data-loaders.js, which every non-AnnData protocol passes
    // through, so the rejection names the file and the offending flat index
    // and happens before any component is scaled. The per-component check in
    // _loadExactField() still owns the direct-AnnData branch, which never
    // reaches that decode boundary.
    await assert.rejects(
      manager.loadField(
        'alpha_umap',
        'X_umap',
        { showProgress: false }
      ),
      /vectors\/0_0\.bin: position 0 is not a finite Float32 value/
    );
  } finally {
    globalThis.fetch = originalFetch;
    dataSourceManager.activeSource = previousSource;
  }
});

test('direct vector reads are bound to the exact adopted AnnData dataset', async () => {
  const dataSourceManager = getDataSourceManager();
  const previous = {
    activeSource: dataSourceManager.activeSource,
    activeDatasetId: dataSourceManager.activeDatasetId,
  };
  const reads = [];
  const loaderOwned = new Float32Array([1, 2, 3, 4]);
  const adapter = {
    // The adapter answers the binding's mapping route at the bound layout's
    // dimension.
    async getVectorPayload(route, dimension) {
      reads.push([route, dimension]);
      return loaderOwned;
    },
  };
  const source = {
    datasetId: 'vector-direct',
    getType() {
      return 'h5ad';
    },
    getAdapter() {
      return adapter;
    },
  };
  dataSourceManager.activeSource = source;
  dataSourceManager.activeDatasetId = source.datasetId;

  try {
    const manager = new VectorFieldManager(directManagerOptions('h5ad://vector-direct/'));
    // `velocity_umap_2d` is listed as the field `velocity_umap`, bound to the
    // layout `X_umap`, and is the default as the only field.
    assert.equal(manager.getDefaultFieldId(), 'velocity_umap');
    assert.equal(manager.hasFieldLayout('velocity_umap', 'X_umap'), true);
    const result = await manager.loadField(
      'velocity_umap',
      'X_umap',
      { showProgress: false }
    );
    assert.deepEqual(reads, [[DIRECT_VECTOR_ROUTE, 2]]);
    assert.deepEqual(Array.from(result.vectors), [2, 4, 6, 8]);
    assert.equal(result.maxMagnitude, 10);
    // The adapter's array is copied before scaling, never scaled in place.
    assert.deepEqual(Array.from(loaderOwned), [1, 2, 3, 4]);
    assert.notEqual(result.vectors, loaderOwned);
  } finally {
    dataSourceManager.activeSource = previous.activeSource;
    dataSourceManager.activeDatasetId = previous.activeDatasetId;
  }
});

test('a replaced direct AnnData dataset cannot publish delayed vector data', async () => {
  const dataSourceManager = getDataSourceManager();
  const previous = {
    activeSource: dataSourceManager.activeSource,
    activeDatasetId: dataSourceManager.activeDatasetId,
  };
  let releaseVector;
  const vectorStarted = new Promise((resolve) => {
    releaseVector = resolve;
  });
  let signalReadStarted;
  const readStarted = new Promise((resolve) => {
    signalReadStarted = resolve;
  });
  const adapter = {
    async getVectorPayload() {
      signalReadStarted();
      await vectorStarted;
      return new Float32Array([1, 2, 3, 4]);
    },
  };
  const source = {
    datasetId: 'vector-old',
    getType() {
      return 'h5ad';
    },
    getAdapter() {
      return adapter;
    },
  };
  dataSourceManager.activeSource = source;
  dataSourceManager.activeDatasetId = source.datasetId;

  try {
    const manager = new VectorFieldManager(directManagerOptions('h5ad://vector-old/'));
    const pending = manager.loadField(
      'velocity_umap',
      'X_umap',
      { showProgress: false }
    );
    await readStarted;
    dataSourceManager.activeSource = null;
    dataSourceManager.activeDatasetId = null;
    releaseVector();
    await assert.rejects(
      pending,
      /active dataset protocol is not AnnData|ownership changed/
    );
  } finally {
    dataSourceManager.activeSource = previous.activeSource;
    dataSourceManager.activeDatasetId = previous.activeDatasetId;
  }
});

test('direct AnnData publishes a default only when exactly one vector field exists', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'assets/js/data/base-anndata-adapter.js'),
    'utf8'
  );
  assert.match(
    source,
    /default_field: fieldIds\.length === 1 \? fieldIds\[0\] : null,/
  );
  assert.doesNotMatch(
    source,
    /fieldsObj\.velocity_umap \? 'velocity_umap' : ids\[0\]/
  );
});

test('vector loading source contains no coercion, repair, or magnitude substitution', () => {
  const managerSource = fs.readFileSync(
    path.join(ROOT, 'assets/js/data/vector-field-manager.js'),
    'utf8'
  );
  const overlaySource = fs.readFileSync(
    path.join(
      ROOT,
      'assets/js/rendering/overlays/velocity/velocity-overlay.js'
    ),
    'utf8'
  );
  assert.doesNotMatch(managerSource, /setBaseUrl|setMetadata/);
  assert.doesNotMatch(managerSource, /Math\.max\(1,\s*Math\.min/);
  assert.doesNotMatch(managerSource, /Number\.parseInt|parseInt|parseFloat/);
  assert.doesNotMatch(managerSource, /Number\.isFinite\(value\)\s*\?\s*value\s*:\s*0/);
  assert.doesNotMatch(managerSource, /maxMagnitude\s*=\s*1/);
  assert.match(
    overlaySource,
    /field\.maxMagnitude === 0 \? 0 : 1\.0 \/ field\.maxMagnitude/
  );
});
