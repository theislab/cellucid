import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  expandObsManifest,
  expandVarManifest,
  loadObsFieldData,
  loadVarFieldData,
} from '../assets/js/data/data-loaders.js';
import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import {
  validateQuantizationTask,
} from '../assets/js/data/quantization-contract.js';
import {
  dequantizeToFloat32Buffer,
  processQuantizationWorkerMessage,
} from '../assets/js/data/quantization-worker.js';
import {
  dequantizeToFloat32InWorker,
  QuantizationWorkerPool,
} from '../assets/js/data/quantization-worker-pool.js';
import {
  createDataSourceManager,
  getDataSourceManager,
} from '../assets/js/data/data-source-manager.js';

const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const h5adModule = await import('../assets/js/data/h5ad.js');

function h5BooleanAttribute(value) {
  return {
    dtype: 'unknown',
    shape: [],
    metadata: {
      signed: true,
      type: 8,
      enum_type: {
        type: 0,
        nmembers: 2,
        members: {
          FALSE: 0,
          TRUE: 1,
        },
      },
      vlen: false,
      littleEndian: true,
      size: 1,
      total_size: 1,
      shape: [],
      maxshape: [],
      chunks: null,
    },
    value: value ? 1 : 0,
  };
}

function contentSecurityPolicyDirectives(html) {
  const meta = html.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([\s\S]*?)"\s*\/?>/i
  );
  assert.ok(meta, 'index.html must define its Content Security Policy');

  return new Map(
    meta[1]
      .split(';')
      .map(directive => directive.trim())
      .filter(Boolean)
      .map(directive => {
        const [name, ...values] = directive.split(/\s+/);
        return [name, values];
      })
  );
}

test('the page CSP permits only the WebAssembly evaluation needed by h5wasm', () => {
  const scriptSources = contentSecurityPolicyDirectives(indexHtml).get('script-src');

  assert.ok(scriptSources, 'CSP must define script-src');
  assert.ok(
    scriptSources.includes("'wasm-unsafe-eval'"),
    "script-src must allow h5wasm compilation with 'wasm-unsafe-eval'"
  );
  assert.ok(
    !scriptSources.includes("'unsafe-eval'"),
    "script-src must not grant general JavaScript 'unsafe-eval'"
  );
});

test('the page CSP permits local HTTP and WebSocket development transports', () => {
  const connectSources =
    contentSecurityPolicyDirectives(indexHtml).get('connect-src');

  assert.ok(connectSources, 'CSP must define connect-src');
  assert.ok(
    connectSources.includes('http:'),
    'connect-src must permit local and IPv6 HTTP data/Worker endpoints'
  );
  assert.ok(
    connectSources.includes('ws:'),
    'connect-src must permit local and IPv6 WebSocket development traffic'
  );
});

test('h5wasm NumPy-style dtype codes map to Cellucid observation kinds', () => {
  const classify = h5adModule.classifyH5WasmDtype;
  assert.equal(typeof classify, 'function');

  for (const code of ['<e', '>f', '<d']) {
    assert.equal(classify(code), 'float', code);
  }
  for (const code of ['<b', '>h', '<i', '>q']) {
    assert.equal(classify(code), 'int', code);
  }
  for (const code of ['<B', '>H', '<I', '>Q']) {
    assert.equal(classify(code), 'uint', code);
  }
  for (const code of ['S', 'S12']) {
    assert.equal(classify(code), 'string', code);
  }
  assert.equal(
    classify('unknown', {
      enum_type: { members: { FALSE: 0, TRUE: 1 } }
    }),
    'bool'
  );
  assert.equal(
    classify('unknown', {
      enum_type: { members: { FALSE: 0, TRUE: 1, UNKNOWN: 2 } }
    }),
    'unknown',
    'enums with a third state must not be collapsed to boolean'
  );
  assert.equal(classify('unknown'), 'unknown');
  assert.equal(classify({ compound_type: [] }), 'unknown');
});

test('H5AD categorical columns resolve only in the current AnnData layout', () => {
  const resolve = h5adModule.resolveH5adCategoricalColumn;
  assert.equal(typeof resolve, 'function');

  const modernCodes = {
    attrs: {
      'encoding-type': { value: 'array' },
      'encoding-version': { value: '0.2.0' }
    },
    dtype: '|i1',
    type: 'Dataset',
    value: new Int8Array([0, 1])
  };
  const modernCategories = {
    attrs: {
      'encoding-type': { value: 'string-array' },
      'encoding-version': { value: '0.2.0' }
    },
    dtype: 'O',
    metadata: {
      cset: 1,
      vlen: true,
    },
    type: 'Dataset',
    value: ['A', 'B']
  };
  const modernColumn = {
    attrs: {
      'encoding-type': { value: 'categorical' },
      'encoding-version': { value: '0.2.0' },
      ordered: h5BooleanAttribute(false)
    },
    type: 'Group',
    keys: () => ['categories', 'codes'],
    get: key => key === 'codes' ? modernCodes : modernCategories
  };
  const modernObs = {
    keys: () => ['label'],
    get: key => key === 'label' ? modernColumn : null
  };
  assert.deepEqual(resolve(modernObs, 'label'), {
    codes: modernCodes,
    categories: modernCategories,
    ordered: false,
  });

  const legacyCodes = { type: 'Dataset', value: new Int8Array([1, 0]) };
  const legacyCategories = { value: ['A', 'B'] };
  const legacyCategoryGroup = {
    type: 'Group',
    keys: () => ['label'],
    get: () => legacyCategories
  };
  const legacyObs = {
    keys: () => ['__categories', 'label'],
    get: key => {
      if (key === 'label') return legacyCodes;
      if (key === '__categories') return legacyCategoryGroup;
      return null;
    }
  };
  assert.equal(
    resolve(legacyObs, 'label'),
    null,
    'dataframe 0.1 __categories compatibility must not reinterpret legacy codes'
  );
});

test('manifest expansion accepts only compact_v1', () => {
  assert.throws(
    () => expandObsManifest({
      version: 1,
      n_points: 1,
      fields: [],
    }),
    /obs.*compact_v1|compact_v1.*obs/i
  );
  assert.throws(
    () => expandVarManifest({
      version: 1,
      n_points: 1,
      fields: [],
    }),
    /var.*compact_v1|compact_v1.*var/i
  );
});

function currentObsManifest({
  continuousSchema = {
    pathPattern: 'obs/{key}.values.f32',
    ext: 'f32',
    dtype: 'float32',
    quantized: false,
  },
  categoricalSchema = {
    codesPathPattern: 'obs/{key}.codes.{ext}',
    outlierPathPattern: 'obs/{key}.outliers.f32',
    outlierExt: 'f32',
    outlierDtype: 'float32',
    outlierQuantized: false,
  },
  continuousFields = [['score']],
  categoricalFields = [[
    'cluster',
    ['A', 'B'],
    'uint8',
    255,
    {
      '2': [
        { category: 'A', position: [0.25, -0.5], n_points: 1 },
        { category: 'B', position: [-0.25, 0.5], n_points: 1 },
      ],
    },
  ]],
  compression = null,
} = {}) {
  const schemas = {};
  if (continuousFields.length > 0) schemas.continuous = continuousSchema;
  if (categoricalFields.length > 0) schemas.categorical = categoricalSchema;
  return {
    _format: 'compact_v1',
    n_points: 2,
    centroid_outlier_quantile: 0.95,
    latent_key: 'latent_space',
    compression,
    _obsSchemas: schemas,
    _continuousFields: continuousFields,
    _categoricalFields: categoricalFields,
  };
}

function currentVarManifest({
  schema = {
    kind: 'continuous',
    pathPattern: 'var/{key}.values.f32',
    ext: 'f32',
    dtype: 'float32',
    quantized: false,
  },
  fields = [['Gene A']],
  quantization = null,
  compression = null,
} = {}) {
  return {
    _format: 'compact_v1',
    n_points: 2,
    var_gene_id_column: null,
    compression,
    quantization,
    _varSchema: schema,
    fields,
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

test('compact_v1 expands the one exact unquantized obs and var contract', () => {
  const obs = expandObsManifest(currentObsManifest());
  assert.deepEqual(obs.fields, [
    {
      key: 'score',
      kind: 'continuous',
      valuesPath: 'obs/score.values.f32',
      valuesDtype: 'float32',
      quantized: false,
      centroids: null,
      outlierQuantilesPath: null,
    },
    {
      key: 'cluster',
      kind: 'category',
      categories: ['A', 'B'],
      codesPath: 'obs/cluster.codes.u8',
      codesDtype: 'uint8',
      codesMissingValue: 255,
      outlierQuantilesPath: 'obs/cluster.outliers.f32',
      outlierDtype: 'float32',
      outlierQuantized: false,
      centroidsByDim: {
        '2': [
          { category: 'A', position: [0.25, -0.5], n_points: 1 },
          { category: 'B', position: [-0.25, 0.5], n_points: 1 },
        ],
      },
    },
  ]);

  const variable = expandVarManifest(currentVarManifest());
  assert.deepEqual(variable.fields, [{
    key: 'Gene A',
    kind: 'continuous',
    valuesPath: 'var/Gene_A.values.f32',
    valuesDtype: 'float32',
    quantized: false,
  }]);
});

test('compact_v1 quantized schemas require exact codec metadata', () => {
  const obs = expandObsManifest(currentObsManifest({
    continuousSchema: {
      pathPattern: 'obs/{key}.values.u8.gz',
      ext: 'u8',
      dtype: 'uint8',
      quantized: true,
      quantizationBits: 8,
    },
    categoricalSchema: {
      codesPathPattern: 'obs/{key}.codes.{ext}.gz',
      outlierPathPattern: 'obs/{key}.outliers.u8.gz',
      outlierExt: 'u8',
      outlierDtype: 'uint8',
      outlierQuantized: true,
    },
    continuousFields: [['score', -2.5, 4.5]],
    categoricalFields: [[
      'cluster',
      ['A'],
      'uint16',
      65_535,
      {},
      0,
      1,
    ]],
    compression: 6,
  }));
  assert.deepEqual(obs.fields[0], {
    key: 'score',
    kind: 'continuous',
    valuesPath: 'obs/score.values.u8.gz',
    valuesDtype: 'uint8',
    quantized: true,
    quantizationBits: 8,
    minValue: -2.5,
    maxValue: 4.5,
    centroids: null,
    outlierQuantilesPath: null,
  });
  assert.deepEqual(obs.fields[1], {
    key: 'cluster',
    kind: 'category',
    categories: ['A'],
    codesPath: 'obs/cluster.codes.u16.gz',
    codesDtype: 'uint16',
    codesMissingValue: 65_535,
    outlierQuantilesPath: 'obs/cluster.outliers.u8.gz',
    outlierDtype: 'uint8',
    outlierQuantized: true,
    outlierMinValue: 0,
    outlierMaxValue: 1,
    centroidsByDim: {},
  });

  const variable = expandVarManifest(currentVarManifest({
    schema: {
      kind: 'continuous',
      pathPattern: 'var/{key}.values.u16.gz',
      ext: 'u16',
      dtype: 'uint16',
      quantized: true,
      quantizationBits: 16,
    },
    fields: [['Gene A', 0, 9]],
    quantization: 16,
    compression: 6,
  }));
  assert.deepEqual(variable.fields[0], {
    key: 'Gene A',
    kind: 'continuous',
    valuesPath: 'var/Gene_A.values.u16.gz',
    valuesDtype: 'uint16',
    quantized: true,
    quantizationBits: 16,
    minValue: 0,
    maxValue: 9,
  });
});

test('direct AnnData manifests use the exact explicit-absence outlier state', () => {
  const adapter = Object.create(BaseAnnDataAdapter.prototype);
  adapter._loader = {
    hasExpressionMatrix: true,
    nObs: 2,
    varNames: ['Gene A'],
  };
  adapter._obsFieldsMetadata = [
    { key: 'score', kind: 'continuous' },
    { key: 'cluster', kind: 'category', categories: ['A', 'B'] },
  ];

  const rawObs = adapter.getObsManifest();
  assert.deepEqual(rawObs._continuousFields, [['score']]);
  assert.deepEqual(rawObs._categoricalFields, [[
    'cluster',
    ['A', 'B'],
    'uint8',
    255,
    {},
  ]]);
  assert.equal(rawObs.centroid_outlier_quantile, null);
  assert.equal(rawObs.latent_key, null);
  assert.deepEqual(rawObs._obsSchemas.categorical, {
    codesPathPattern: 'obs/{key}.codes.{ext}',
    outlierPathPattern: null,
    outlierExt: null,
    outlierDtype: null,
    outlierQuantized: false,
  });

  const expandedObs = expandObsManifest(rawObs);
  const categorical = expandedObs.fields[1];
  assert.equal(categorical.outlierQuantilesPath, null);
  assert.equal(categorical.outlierDtype, null);
  assert.equal(categorical.outlierQuantized, false);
  assert.equal(
    Object.hasOwn(categorical, 'outlierMinValue'),
    false
  );

  assert.deepEqual(
    expandVarManifest(adapter.getVarManifest()).fields,
    [{
      key: 'Gene A',
      kind: 'continuous',
      valuesPath: 'var/Gene_A.values.f32',
      valuesDtype: 'float32',
      quantized: false,
    }]
  );
});

test('compact_v1 rejects mixed categorical outlier availability states', () => {
  const mixed = currentObsManifest({
    continuousFields: [],
    categoricalSchema: {
      codesPathPattern: 'obs/{key}.codes.{ext}',
      outlierPathPattern: null,
      outlierExt: 'f32',
      outlierDtype: null,
      outlierQuantized: false,
    },
    categoricalFields: [[
      'cluster', ['A'], 'uint8', 255, {},
    ]],
  });
  assert.throws(
    () => expandObsManifest(mixed),
    /outlier.*all present or all null/i
  );

  const absentButQuantized = currentObsManifest({
    continuousFields: [],
    categoricalSchema: {
      codesPathPattern: 'obs/{key}.codes.{ext}',
      outlierPathPattern: null,
      outlierExt: null,
      outlierDtype: null,
      outlierQuantized: true,
    },
    categoricalFields: [[
      'cluster', ['A'], 'uint8', 255, {}, 0, 1,
    ]],
  });
  assert.throws(
    () => expandObsManifest(absentButQuantized),
    /absent outlier data.*false/i
  );
});

test('compact_v1 rejects missing, extra, or contradictory schema properties', () => {
  const cases = [
    {
      label: 'missing top-level obs key',
      value: currentObsManifest(),
      mutate(value) {
        delete value.latent_key;
      },
      expand: expandObsManifest,
    },
    {
      label: 'extra top-level obs key',
      value: currentObsManifest(),
      mutate(value) {
        value.version = 1;
      },
      expand: expandObsManifest,
    },
    {
      label: 'missing continuous schema key',
      value: currentObsManifest(),
      mutate(value) {
        delete value._obsSchemas.continuous.dtype;
      },
      expand: expandObsManifest,
    },
    {
      label: 'extra continuous schema key',
      value: currentObsManifest(),
      mutate(value) {
        value._obsSchemas.continuous.bits = 32;
      },
      expand: expandObsManifest,
    },
    {
      label: 'schema without fields',
      value: currentObsManifest({ continuousFields: [] }),
      mutate(value) {
        value._obsSchemas.continuous = {
          pathPattern: 'obs/{key}.values.f32',
          ext: 'f32',
          dtype: 'float32',
          quantized: false,
        };
      },
      expand: expandObsManifest,
    },
    {
      label: 'fields without schema',
      value: currentObsManifest(),
      mutate(value) {
        delete value._obsSchemas.continuous;
      },
      expand: expandObsManifest,
    },
    {
      label: 'float schema marked quantized',
      value: currentObsManifest(),
      mutate(value) {
        value._obsSchemas.continuous.quantized = true;
        value._obsSchemas.continuous.quantizationBits = 8;
      },
      expand: expandObsManifest,
    },
    {
      label: 'uint8 schema with 16 bits',
      value: currentObsManifest(),
      mutate(value) {
        value._obsSchemas.continuous = {
          pathPattern: 'obs/{key}.values.u8',
          ext: 'u8',
          dtype: 'uint8',
          quantized: true,
          quantizationBits: 16,
        };
        value._continuousFields = [['score', 0, 1]];
      },
      expand: expandObsManifest,
    },
    {
      label: 'outlier extension disagrees with dtype',
      value: currentObsManifest(),
      mutate(value) {
        value._obsSchemas.categorical.outlierExt = 'u8';
      },
      expand: expandObsManifest,
    },
    {
      label: 'missing top-level var key',
      value: currentVarManifest(),
      mutate(value) {
        delete value.var_gene_id_column;
      },
      expand: expandVarManifest,
    },
    {
      label: 'extra var schema key',
      value: currentVarManifest(),
      mutate(value) {
        value._varSchema.codec = 'raw';
      },
      expand: expandVarManifest,
    },
    {
      label: 'top-level var quantization disagrees',
      value: currentVarManifest(),
      mutate(value) {
        value.quantization = 8;
      },
      expand: expandVarManifest,
    },
  ];

  for (const { label, value, mutate, expand } of cases) {
    const candidate = cloneJson(value);
    mutate(candidate);
    assert.throws(
      () => expand(candidate),
      /compact_v1|schema|property|properties|quantiz|field|latent_key|var_gene_id_column/i,
      label
    );
  }
});

test('compact_v1 validates path templates and compression exactly', () => {
  const cases = [
    ['missing key placeholder', value => {
      value._obsSchemas.continuous.pathPattern = 'obs/score.values.f32';
    }],
    ['duplicate key placeholder', value => {
      value._obsSchemas.continuous.pathPattern =
        'obs/{key}/{key}.values.f32';
    }],
    ['unknown placeholder', value => {
      value._obsSchemas.continuous.pathPattern =
        'obs/{key}.values.{dtype}';
    }],
    ['absolute path', value => {
      value._obsSchemas.continuous.pathPattern =
        '/obs/{key}.values.f32';
    }],
    ['parent traversal', value => {
      value._obsSchemas.continuous.pathPattern =
        '../obs/{key}.values.f32';
    }],
    ['encoded parent traversal', value => {
      value._obsSchemas.continuous.pathPattern =
        'obs/%2e%2e/{key}.values.f32';
    }],
    ['missing categorical extension placeholder', value => {
      value._obsSchemas.categorical.codesPathPattern =
        'obs/{key}.codes.u8';
    }],
    ['unexpected categorical extension placeholder', value => {
      value._obsSchemas.categorical.outlierPathPattern =
        'obs/{key}.outliers.{ext}';
    }],
    ['compressed metadata without gzip paths', value => {
      value.compression = 6;
    }],
  ];

  for (const [label, mutate] of cases) {
    const candidate = currentObsManifest();
    mutate(candidate);
    assert.throws(
      () => expandObsManifest(candidate),
      /path|placeholder|relative|compression|gzip|compact_v1/i,
      label
    );
  }

  const variable = currentVarManifest();
  variable._varSchema.pathPattern = 'var/{key}.values.f32.gz';
  assert.throws(
    () => expandVarManifest(variable),
    /compression|gzip|path/i
  );
});

test('compact_v1 rejects malformed tuple arity, bounds, and field collisions', () => {
  const continuousCases = [
    ['missing quantized bounds', [['score']]],
    ['partial quantized bounds', [['score', 0]]],
    ['nonfinite minimum', [['score', Number.NaN, 1]]],
    ['nonfinite maximum', [['score', 0, Number.POSITIVE_INFINITY]]],
    ['reversed range', [['score', 2, 1]]],
    ['zero range', [['score', 1, 1]]],
    ['non-string key', [[1, 0, 1]]],
  ];
  for (const [label, continuousFields] of continuousCases) {
    const candidate = currentObsManifest({
      continuousSchema: {
        pathPattern: 'obs/{key}.values.u8',
        ext: 'u8',
        dtype: 'uint8',
        quantized: true,
        quantizationBits: 8,
      },
      continuousFields,
      categoricalFields: [],
    });
    assert.throws(
      () => expandObsManifest(candidate),
      /tuple|field|key|bound|min|max|finite|range|compact_v1/i,
      label
    );
  }

  assert.throws(
    () => expandObsManifest(currentObsManifest({
      continuousFields: [['A B'], ['A/B']],
      categoricalFields: [],
    })),
    /collision|unique|A_B|path/i
  );
  assert.throws(
    () => expandObsManifest(currentObsManifest({
      continuousFields: [['same']],
      categoricalFields: [[
        'same', ['A'], 'uint8', 255, {},
      ]],
    })),
    /duplicate|unique|same/i
  );
  assert.throws(
    () => expandVarManifest(currentVarManifest({
      fields: [['A B'], ['A/B']],
    })),
    /collision|unique|A_B|path/i
  );
});

test('compact_v1 categorical tuples enforce dtype, capacity, and sentinel', () => {
  const cases = [
    ['wrong uint8 sentinel', ['group', ['A'], 'uint8', 65_535, {}]],
    ['wrong uint16 sentinel', ['group', ['A'], 'uint16', 255, {}]],
    ['unsupported dtype', ['group', ['A'], 'uint32', 0xffff_ffff, {}]],
    ['duplicate categories', ['group', ['A', 'A'], 'uint8', 255, {}]],
    ['invalid category value', ['group', [{}], 'uint8', 255, {}]],
    ['too many uint8 categories', [
      'group',
      Array.from({ length: 256 }, (_, index) => `C${index}`),
      'uint8',
      255,
      {},
    ]],
    ['unquantized tuple has codec bounds', [
      'group', ['A'], 'uint8', 255, {}, 0, 1,
    ]],
  ];

  for (const [label, tuple] of cases) {
    assert.throws(
      () => expandObsManifest(currentObsManifest({
        continuousFields: [],
        categoricalFields: [tuple],
      })),
      /categor|dtype|sentinel|missing|tuple|capacity|unique|value|compact_v1/i,
      label
    );
  }

  assert.throws(
    () => expandObsManifest(currentObsManifest({
      continuousFields: [],
      categoricalSchema: {
        codesPathPattern: 'obs/{key}.codes.{ext}',
        outlierPathPattern: 'obs/{key}.outliers.u8',
        outlierExt: 'u8',
        outlierDtype: 'uint8',
        outlierQuantized: true,
      },
      categoricalFields: [[
        'group', ['A'], 'uint8', 255, {}, 0,
      ]],
    })),
    /tuple|outlier|min|max|bound/i
  );
});

test('compact_v1 validates every centroid dimension and category reference', () => {
  const centroidCases = [
    ['invalid dimension', {
      '4': [{ category: 'A', position: [0, 0, 0, 0], n_points: 1 }],
    }],
    ['wrong position arity', {
      '2': [{ category: 'A', position: [0], n_points: 1 }],
    }],
    ['nonfinite position', {
      '2': [{ category: 'A', position: [0, Number.NaN], n_points: 1 }],
    }],
    ['unknown category', {
      '2': [{ category: 'B', position: [0, 0], n_points: 1 }],
    }],
    ['negative count', {
      '2': [{ category: 'A', position: [0, 0], n_points: -1 }],
    }],
    ['extra centroid property', {
      '2': [{
        category: 'A',
        position: [0, 0],
        n_points: 1,
        label: 'A',
      }],
    }],
  ];

  for (const [label, centroids] of centroidCases) {
    assert.throws(
      () => expandObsManifest(currentObsManifest({
        continuousFields: [],
        categoricalFields: [[
          'group', ['A'], 'uint8', 255, centroids,
        ]],
      })),
      /centroid|dimension|position|category|n_points|property|finite/i,
      label
    );
  }
});

test('custom protocol resolution requires one registered exact resolver', async t => {
  await t.test('rejects a custom protocol with no registered source', async () => {
    const manager = createDataSourceManager();
    manager.registerProtocol('strict://', 'strict-source');

    await assert.rejects(
      manager.resolveUrl('strict://dataset/obs_manifest.json', null),
      /registered source.*strict-source|strict-source.*registered source/i
    );
  });

  await t.test('never calls the removed getFileUrl alternative', async () => {
    const manager = createDataSourceManager();
    let getFileUrlCalls = 0;
    manager.registerProtocol('strict://', 'strict-source');
    manager.registerSource('strict-source', {
      getType() {
        return 'strict-source';
      },
      async getFileUrl() {
        getFileUrlCalls += 1;
        return 'https://example.test/legacy.bin';
      },
    });

    await assert.rejects(
      manager.resolveUrl('strict://dataset/values.bin', null),
      /strict-source.*resolveUrl|resolveUrl.*strict-source/i
    );
    assert.equal(getFileUrlCalls, 0);
  });

  await t.test('delegates the complete URL and exact signal once', async () => {
    const manager = createDataSourceManager();
    const controller = new AbortController();
    const requestedUrl = 'strict://dataset/values.bin';
    let calls = 0;
    manager.registerProtocol('strict://', 'strict-source');
    manager.registerSource('strict-source', {
      getType() {
        return 'strict-source';
      },
      async resolveUrl(url, signal) {
        calls += 1;
        assert.equal(url, requestedUrl);
        assert.strictEqual(signal, controller.signal);
        return 'https://example.test/current.bin';
      },
    });

    assert.equal(
      await manager.resolveUrl(requestedUrl, controller.signal),
      'https://example.test/current.bin'
    );
    assert.equal(calls, 1);
  });
});

test('custom protocol registry preserves every prototype-named protocol as an exact own handler', () => {
  const manager = createDataSourceManager();
  const prototypeNames = Object.getOwnPropertyNames(Object.prototype);
  const prototypeDescriptors = Object.getOwnPropertyDescriptors(
    Object.prototype,
  );

  for (const [index, protocol] of prototypeNames.entries()) {
    manager.registerProtocol(protocol, `prototype-source-${index}`);
  }

  const handlers = manager.getProtocolHandlers();
  assert.equal(Object.getPrototypeOf(handlers), Object.prototype);
  for (const [index, protocol] of prototypeNames.entries()) {
    const sourceType = `prototype-source-${index}`;
    assert.equal(Object.hasOwn(handlers, protocol), true, protocol);
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(handlers, protocol),
      {
        configurable: true,
        enumerable: true,
        value: sourceType,
        writable: true,
      },
      protocol,
    );
    assert.equal(
      manager.isCustomProtocolUrl(`${protocol}/dataset`),
      true,
      protocol,
    );
    assert.equal(
      manager.getSourceTypeForUrl(`${protocol}/dataset`),
      sourceType,
      protocol,
    );
  }
  assert.deepEqual(
    Object.getOwnPropertyDescriptors(Object.prototype),
    prototypeDescriptors,
  );
});

test('field loaders reject incomplete scientific codec metadata before fetching', async t => {
  const manager = getDataSourceManager();
  const originalActiveSource = manager.activeSource;
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  manager.activeSource = null;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(Uint8Array.of(0, 254, 255));
  };
  t.after(() => {
    manager.activeSource = originalActiveSource;
    globalThis.fetch = originalFetch;
  });

  const invalidFields = [
    {
      load: loadObsFieldData,
      field: {
        ...expandObsManifest(currentObsManifest({
          categoricalFields: [],
        })).fields[0],
        legacyDtype: 'float32',
      },
    },
    {
      load: loadObsFieldData,
      field: {
        key: 'score',
        kind: 'continuous',
        valuesPath: 'obs/score.values.u8',
        valuesDtype: 'uint8',
        quantized: true,
        minValue: 0,
        maxValue: 1,
      },
    },
    {
      load: loadObsFieldData,
      field: {
        key: 'cluster',
        kind: 'category',
        categories: ['A'],
        codesPath: 'obs/cluster.codes.u8',
        codesDtype: 'uint8',
        outlierQuantilesPath: 'obs/cluster.outliers.f32',
        outlierDtype: 'float32',
        outlierQuantized: false,
        centroidsByDim: {},
      },
    },
    {
      load: loadVarFieldData,
      field: {
        key: 'Gene A',
        kind: 'continuous',
        valuesPath: 'var/Gene_A.values.u16',
        valuesDtype: 'uint16',
        quantized: true,
        quantizationBits: 16,
        minValue: 2,
        maxValue: 1,
      },
    },
  ];

  for (const { load, field } of invalidFields) {
    await assert.rejects(
      load('https://example.test/manifest.json', field),
      /codec|quantiz|sentinel|missing|range|min|max|propert/i
    );
  }
  assert.equal(fetchCount, 0);
});

test('field loaders dequantize only the exact declared range and missing marker', async t => {
  const manager = getDataSourceManager();
  const originalActiveSource = manager.activeSource;
  const originalFetch = globalThis.fetch;
  manager.activeSource = null;
  globalThis.fetch = async () =>
    new Response(Uint8Array.of(0, 127, 254, 255));
  t.after(() => {
    manager.activeSource = originalActiveSource;
    globalThis.fetch = originalFetch;
  });

  const manifest = currentObsManifest({
    continuousSchema: {
      pathPattern: 'obs/{key}.values.u8',
      ext: 'u8',
      dtype: 'uint8',
      quantized: true,
      quantizationBits: 8,
    },
    continuousFields: [['score', 10, 20]],
    categoricalFields: [],
  });
  const [field] = expandObsManifest(manifest).fields;
  const loaded = await loadObsFieldData(
    'https://example.test/obs_manifest.json',
    field
  );
  assert.deepEqual(
    Array.from(loaded.values.slice(0, 3)),
    [10, 15, 20]
  );
  assert.equal(Number.isNaN(loaded.values[3]), true);
});

test('prepared categorical outliers adopt the exact runtime missing sentinel', async t => {
  const manager = getDataSourceManager();
  const originalActiveSource = manager.activeSource;
  const originalFetch = globalThis.fetch;
  manager.activeSource = null;
  t.after(() => {
    manager.activeSource = originalActiveSource;
    globalThis.fetch = originalFetch;
  });

  await t.test('quantized reserved marker becomes -1', async () => {
    globalThis.fetch = async url => new Response(
      String(url).includes('.codes.')
        ? Uint8Array.of(0, 1)
        : Uint8Array.of(127, 255)
    );
    const [field] = expandObsManifest(currentObsManifest({
      continuousFields: [],
      categoricalSchema: {
        codesPathPattern: 'obs/{key}.codes.{ext}',
        outlierPathPattern: 'obs/{key}.outliers.u8',
        outlierExt: 'u8',
        outlierDtype: 'uint8',
        outlierQuantized: true,
      },
      categoricalFields: [[
        'cluster', ['A', 'B'], 'uint8', 255, {}, 0, 1,
      ]],
    })).fields;

    const loaded = await loadObsFieldData(
      'https://example.test/obs_manifest.json',
      field
    );
    assert.deepEqual(
      Array.from(loaded.outlierQuantiles),
      [Math.fround(127 / 254), -1]
    );
  });

  await t.test('unquantized NaN becomes -1', async () => {
    globalThis.fetch = async url => new Response(
      String(url).includes('.codes.')
        ? Uint8Array.of(0, 1)
        : Float32Array.of(0.25, Number.NaN)
    );
    const fields = expandObsManifest(currentObsManifest({
      continuousFields: [],
    })).fields;

    const loaded = await loadObsFieldData(
      'https://example.test/obs_manifest.json',
      fields[0]
    );
    assert.deepEqual(Array.from(loaded.outlierQuantiles), [0.25, -1]);
  });
});

test('prepared categorical outliers reject non-missing values outside [0, 1]', async t => {
  const manager = getDataSourceManager();
  const originalActiveSource = manager.activeSource;
  const originalFetch = globalThis.fetch;
  manager.activeSource = null;
  globalThis.fetch = async url => new Response(
    String(url).includes('.codes.')
      ? Uint8Array.of(0, 1)
      : Float32Array.of(-0.5, 0.5)
  );
  t.after(() => {
    manager.activeSource = originalActiveSource;
    globalThis.fetch = originalFetch;
  });

  const [field] = expandObsManifest(currentObsManifest({
    continuousFields: [],
  })).fields;
  await assert.rejects(
    loadObsFieldData(
      'https://example.test/obs_manifest.json',
      field
    ),
    /outlier quantile 0.*-1 or a finite value from 0 through 1/i
  );
});

test('field quantization selects one backend before fetch and never refetches after failure', async t => {
  const manager = getDataSourceManager();
  const originalActiveSource = manager.activeSource;
  const originalFetch = globalThis.fetch;
  const hadOwnWorker = Object.hasOwn(globalThis, 'Worker');
  const originalWorker = globalThis.Worker;
  const events = [];
  let fetchCount = 0;

  class FailingWorker {
    constructor() {
      events.push('worker:init');
      this.onmessage = null;
      this.onerror = null;
    }

    postMessage(_message, transferables) {
      events.push('worker:post');
      assert.equal(transferables.length, 1);
      queueMicrotask(() => {
        this.onerror?.({ message: 'synthetic quantization backend failure' });
      });
    }

    terminate() {
      events.push('worker:terminate');
    }
  }

  manager.activeSource = null;
  globalThis.Worker = FailingWorker;
  globalThis.fetch = async () => {
    fetchCount += 1;
    events.push('fetch');
    return new Response(new Uint8Array(256 * 1024));
  };
  t.after(() => {
    manager.activeSource = originalActiveSource;
    globalThis.fetch = originalFetch;
    if (hadOwnWorker) {
      globalThis.Worker = originalWorker;
    } else {
      delete globalThis.Worker;
    }
  });

  const [field] = expandObsManifest(currentObsManifest({
    continuousSchema: {
      pathPattern: 'obs/{key}.values.u8',
      ext: 'u8',
      dtype: 'uint8',
      quantized: true,
      quantizationBits: 8,
    },
    continuousFields: [['score', 0, 1]],
    categoricalFields: [],
  })).fields;

  await assert.rejects(
    loadObsFieldData(
      'https://example.test/obs_manifest.json',
      field
    ),
    /synthetic quantization backend failure/i
  );
  const firstFetchIndex = events.indexOf('fetch');
  assert.ok(firstFetchIndex > 0);
  assert.equal(
    events.slice(0, firstFetchIndex).every(event => event === 'worker:init'),
    true
  );
  assert.equal(fetchCount, 1);
});

test('quantization worker boundaries enforce the same exact scientific task', async () => {
  const validTask = () => ({
    buffer: Uint8Array.of(0, 127, 254, 255).buffer,
    dtype: 'uint8',
    bits: 8,
    minValue: 10,
    maxValue: 20,
  });
  const validated = validTask();
  assert.strictEqual(validateQuantizationTask(validated), validated);

  const invalidTasks = [
    null,
    {
      buffer: Uint8Array.of(0).buffer,
      dtype: 'uint8',
      minValue: 0,
      maxValue: 1,
    },
    {
      ...validTask(),
      codec: 'raw',
    },
    {
      ...validTask(),
      bits: 16,
    },
    {
      ...validTask(),
      minValue: Number.NaN,
    },
    {
      ...validTask(),
      minValue: 1,
      maxValue: 1,
    },
    {
      buffer: new ArrayBuffer(1),
      dtype: 'uint16',
      bits: 16,
      minValue: 0,
      maxValue: 1,
    },
  ];
  for (const task of invalidTasks) {
    assert.throws(
      () => validateQuantizationTask(task),
      /quantization.*(object|propert|dtype|bits|finite|minValue|byte length)/i
    );
    await assert.rejects(
      dequantizeToFloat32InWorker(task),
      /quantization.*(object|propert|dtype|bits|finite|minValue|byte length)/i
    );
  }

  const decoded = new Float32Array(
    dequantizeToFloat32Buffer(validTask())
  );
  assert.deepEqual(Array.from(decoded.slice(0, 3)), [10, 15, 20]);
  assert.equal(Number.isNaN(decoded[3]), true);

  const response = processQuantizationWorkerMessage({
    type: 'DEQUANTIZE_TO_F32',
    payload: validTask(),
    requestId: 'request-1',
  });
  assert.equal(response.requestId, 'request-1');
  assert.deepEqual(
    Array.from(new Float32Array(response.result.buffer).slice(0, 3)),
    [10, 15, 20]
  );
  assert.throws(
    () => processQuantizationWorkerMessage({
      type: 'DEQUANTIZE_TO_F32',
      payload: validTask(),
    }),
    /exactly type, payload, and requestId/i
  );
  assert.throws(
    () => processQuantizationWorkerMessage({
      type: 'DEQUANTIZE',
      payload: validTask(),
      requestId: 'request-2',
    }),
    /unknown quantization worker message type/i
  );

  assert.throws(
    () => new QuantizationWorkerPool({ poolSize: 1.5 }),
    /poolSize.*integer from 1 to 4/i
  );
  assert.throws(
    () => new QuantizationWorkerPool({ poolSize: 1, alias: true }),
    /only poolSize/i
  );

  const pool = new QuantizationWorkerPool({ poolSize: 1 });
  let responseError = null;
  pool._available = true;
  pool.workers = [{ terminate() {} }];
  pool.states = ['busy'];
  pool.queues = [[]];
  pool._pending.set('request-malformed', {
    resolve() {},
    reject(error) {
      responseError = error;
    },
    workerIndex: 0,
  });
  pool._handleMessage(0, {
    data: {
      requestId: 'request-malformed',
      success: 1,
      result: { buffer: new ArrayBuffer(4) },
    },
  });
  assert.match(
    responseError?.message ?? '',
    /success must be a boolean/i
  );
  assert.equal(pool._available, false);
});

test('categorical field loading rejects codes outside labels or the exact sentinel', async t => {
  const manager = getDataSourceManager();
  const originalActiveSource = manager.activeSource;
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  manager.activeSource = null;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(Uint8Array.of(0, 2, 255));
  };
  t.after(() => {
    manager.activeSource = originalActiveSource;
    globalThis.fetch = originalFetch;
  });

  const manifest = currentObsManifest({
    continuousFields: [],
    categoricalSchema: {
      codesPathPattern: 'obs/{key}.codes.{ext}',
      outlierPathPattern: null,
      outlierExt: null,
      outlierDtype: null,
      outlierQuantized: false,
    },
    categoricalFields: [[
      'cluster', ['A', 'B'], 'uint8', 255, {},
    ]],
  });
  const [field] = expandObsManifest(manifest).fields;
  await assert.rejects(
    loadObsFieldData(
      'https://example.test/obs_manifest.json',
      field
    ),
    /code 2.*index 1.*2 declared categories/i
  );
  assert.equal(fetchCount, 1);
});

test('direct AnnData categorical fields do not invent outlier statistics', async t => {
  const manager = getDataSourceManager();
  const originalActiveSource = manager.activeSource;
  const originalActiveDatasetId = manager.activeDatasetId;
  manager.activeSource = {
    datasetId: 'strict-current',
    getType: () => 'h5ad',
    getAdapter: () => ({
      async getObsFieldData() {
        return {
          kind: 'category',
          data: Uint8Array.from([0, 1]).buffer,
          dtype: 'uint8',
          missingValue: 255,
          categories: ['A', 'B'],
        };
      },
    }),
  };
  manager.activeDatasetId = 'strict-current';
  t.after(() => {
    manager.activeSource = originalActiveSource;
    manager.activeDatasetId = originalActiveDatasetId;
  });

  const result = await loadObsFieldData(
    'h5ad://strict-current/obs_manifest.json',
    expandObsManifest(currentObsManifest({
      continuousFields: [],
      categoricalSchema: {
        codesPathPattern: 'obs/{key}.codes.{ext}',
        outlierPathPattern: null,
        outlierExt: null,
        outlierDtype: null,
        outlierQuantized: false,
      },
      categoricalFields: [[
        'label', ['A', 'B'], 'uint8', 255, {},
      ]],
    })).fields[0]
  );
  assert.deepEqual(Array.from(result.codes), [0, 1]);
  assert.equal(
    Object.hasOwn(result, 'outlierQuantiles'),
    false
  );
});
