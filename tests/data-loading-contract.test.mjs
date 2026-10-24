import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  checkObsFields,
  checkGeneList,
  loadObsFieldData,
  loadVarFieldData,
} from '../assets/js/data/data-loaders.js';
import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import { getDataSourceManager } from '../assets/js/data/data-source-manager.js';
import { ZARR_FORMAT, valueKind } from '../assets/js/data/anndata/elements.js';
import { resolveCategoricalColumn } from '../assets/js/data/anndata/dataframe.js';
import { BOOL_DTYPE, numericDtype, stringDtype } from '../assets/js/formats/store.js';
import { storeDtype } from '../assets/js/formats/hdf5/datatype.js';
import { array, categorical, group, openStore, strings } from './helpers/anndata-store.mjs';

const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');

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

test('the page CSP grants no code evaluation, WebAssembly included', () => {
  const scriptSources = contentSecurityPolicyDirectives(indexHtml).get('script-src');

  assert.ok(scriptSources, 'CSP must define script-src');
  assert.ok(
    !scriptSources.includes("'wasm-unsafe-eval'"),
    "script-src must not grant 'wasm-unsafe-eval': the app compiles no WebAssembly"
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

test('store element types map to Cellucid observation kinds, whatever their byte order', () => {
  const node = dtype => ({ kind: 'array', shape: [1], dtype, read() {} });
  for (const bytes of [2, 4, 8]) {
    for (const littleEndian of [true, false]) {
      assert.equal(valueKind(node(numericDtype('float', bytes, littleEndian))), 'float', `float${bytes * 8}`);
    }
  }
  for (const bytes of [1, 2, 4, 8]) {
    for (const littleEndian of [true, false]) {
      assert.equal(valueKind(node(numericDtype('int', bytes, littleEndian))), 'int', `int${bytes * 8}`);
      assert.equal(valueKind(node(numericDtype('uint', bytes, littleEndian))), 'uint', `uint${bytes * 8}`);
    }
  }
  assert.equal(valueKind(node(stringDtype({ variable: false, encoding: 'ascii', bytes: 12 }))), 'string');
  assert.equal(valueKind(node(stringDtype({ variable: true, encoding: 'utf-8' }))), 'string');
  assert.equal(valueKind(node(BOOL_DTYPE)), 'bool');

  // HDF5 enums: FALSE = 0, TRUE = 1 is a boolean; a third state is not.
  const byte = { class: 'fixed-point', size: 1, signed: true, littleEndian: true, bitOffset: 0, precision: 8 };
  assert.equal(
    valueKind(node(storeDtype({ class: 'enum', size: 1, base: byte, names: ['FALSE', 'TRUE'], values: [0, 1] }))),
    'bool'
  );
  assert.equal(
    valueKind(node(storeDtype({ class: 'enum', size: 1, base: byte, names: ['FALSE', 'TRUE', 'UNKNOWN'], values: [0, 1, 2] }))),
    'unknown',
    'enums with a third state must not be collapsed to boolean'
  );
  assert.equal(valueKind(node({ kind: 'compound', name: 'compound', bytes: 8, littleEndian: null, fields: [] })), 'unknown');
  assert.equal(valueKind(node({ kind: 'opaque', name: 'opaque', bytes: 4, littleEndian: null })), 'unknown');
  assert.equal(valueKind(null), 'unknown');
});

test('AnnData categorical columns resolve only in the current AnnData layout', async () => {
  const { root } = await openStore(group({
    obs: group({
      label: categorical([0, 1], ['A', 'B']),
    }),
    legacy: group({
      label: array(new Int8Array([1, 0]), { dtype: '|i1', attrs: null }),
      __categories: group({ label: strings(['A', 'B'], { attrs: null }) }),
    }),
  }, null));
  const modern = resolveCategoricalColumn(root.get('obs'), 'label', ZARR_FORMAT);
  assert.equal(modern.codes.path, '/obs/label/codes');
  assert.equal(modern.categories.path, '/obs/label/categories');
  assert.equal(modern.ordered, false);

  assert.equal(
    resolveCategoricalColumn(root.get('legacy'), 'label', ZARR_FORMAT),
    null,
    'dataframe 0.1 __categories compatibility must not reinterpret legacy codes'
  );
});

/** The obs field list the AnnData adapter builds (`getObsFields`). */
function currentObsFields({
  outlierQuantilesPath = 'outliers/0/1',
  continuous = ['score'],
  categorical = [{ key: 'cluster', categories: ['A', 'B'], codesDtype: 'uint8', codesMissingValue: 255 }],
} = {}) {
  return {
    n_points: 2,
    outlier_min_points: 10,
    stored_outlier_latent_key: null,
    latent_key: 'latent_space',
    fields: [
      ...continuous.map((key, fieldIndex) => ({ key, kind: 'continuous', fieldIndex, outlierQuantilesPath: null })),
      ...categorical.map((field, position) => ({
        kind: 'category',
        fieldIndex: continuous.length + position,
        palette: null,
        outlierQuantilesPath,
        ...field,
      })),
    ],
  };
}

/** The gene list the AnnData adapter builds (`getGeneList`). */
function currentGeneList({ names = ['Gene A'] } = {}) {
  return {
    n_points: 2,
    fields: names.map((key, gene) => ({ key, kind: 'continuous', path: `var/${gene}` })),
    geneNames: { source: null, filledFromIndex: 0, renamed: [] },
  };
}

test('the adapter\'s field lists check into one descriptor per field', () => {
  const obs = checkObsFields(currentObsFields());
  assert.deepEqual(obs.fields, [
    {
      key: 'score',
      kind: 'continuous',
      fieldIndex: 0,
      outlierQuantilesPath: null,
    },
    {
      key: 'cluster',
      kind: 'category',
      fieldIndex: 1,
      categories: ['A', 'B'],
      codesDtype: 'uint8',
      codesMissingValue: 255,
      palette: null,
      outlierQuantilesPath: 'outliers/0/1',
    },
  ]);
  const genes = checkGeneList(currentGeneList());
  assert.deepEqual(genes.fields, [
    { key: 'Gene A', kind: 'continuous', path: 'var/0' },
  ]);
  assert.deepEqual(genes.geneNames.names, ['Gene A']);
});

test('field lists in any other form are refused: extra members, centroids, mis-indexed, other routes', () => {
  assert.throws(() => checkObsFields({ ...currentObsFields(), compression: null }), /obs field list/);
  const centroids = currentObsFields();
  centroids.fields[1] = { ...centroids.fields[1], centroids: { X_umap: [] } };
  assert.throws(() => checkObsFields(centroids), /categorical obs field properties: unexpected centroids/);
  const misIndexed = currentObsFields();
  misIndexed.fields[0] = { ...misIndexed.fields[0], fieldIndex: 2 };
  assert.throws(() => checkObsFields(misIndexed), /field indices must be exactly 0\.\.1/);
  assert.throws(
    () => checkObsFields(currentObsFields({ outlierQuantilesPath: 'outliers/0/0' })),
    /outlierQuantilesPath must be null or this field's outlier route/
  );
  assert.throws(() => checkGeneList({ ...currentGeneList(), quantization: null }), /gene list/);
  const misplaced = currentGeneList({ names: ['Gene A', 'Gene B'] });
  misplaced.fields[1] = { ...misplaced.fields[1], path: 'var/X/index/1' };
  assert.throws(() => checkGeneList(misplaced), /continuous gene at \{list\}\/1/);
  assert.throws(
    () => checkGeneList({ ...currentGeneList(), geneNames: { source: null, filledFromIndex: 1, renamed: [] } }),
    /filledFromIndex must count genes/
  );
  assert.throws(
    () => checkObsFields(currentObsFields({
      categorical: [{ key: 'cluster', categories: ['A', 'B'], codesDtype: 'uint64', codesMissingValue: 0xffff_ffff }],
    })),
    /unsupported categorical codes dtype.*uint64/i
  );
});

test('field loaders read only an AnnData dataset', async () => {
  const [, cluster] = checkObsFields(currentObsFields()).fields;
  await assert.rejects(
    loadObsFieldData('https://example.test/obs', cluster),
    /h5ad:\/\/ or zarr:\/\/ URL/
  );
  const [gene] = checkGeneList(currentGeneList()).fields;
  await assert.rejects(
    loadVarFieldData('https://example.test/var', gene),
    /h5ad:\/\/ or zarr:\/\/ URL/
  );
});

test('categorical field loading rejects codes outside labels or the exact sentinel', async t => {
  const manager = getDataSourceManager();
  const originalActiveSource = manager.activeSource;
  const originalActiveDatasetId = manager.activeDatasetId;
  manager.activeSource = {
    datasetId: 'bad-codes',
    getType: () => 'h5ad',
    getAdapter: () => ({
      async getObsFieldData() {
        return {
          kind: 'category',
          data: Uint8Array.of(0, 2, 255).buffer,
          dtype: 'uint8',
          missingValue: 255,
          categories: ['A', 'B'],
        };
      },
    }),
  };
  manager.activeDatasetId = 'bad-codes';
  t.after(() => {
    manager.activeSource = originalActiveSource;
    manager.activeDatasetId = originalActiveDatasetId;
  });
  const [field] = checkObsFields(currentObsFields({
    continuous: [],
    outlierQuantilesPath: null,
  })).fields;
  await assert.rejects(
    loadObsFieldData('h5ad://bad-codes/obs', field),
    /code 2.*index 1.*2 declared categories/i
  );
});

test('direct AnnData field lists use the exact explicit-absence outlier state', async () => {
  const adapter = Object.create(BaseAnnDataAdapter.prototype);
  adapter._loader = {
    nObs: 2,
    readVarNames: async () => ({ index: ['Gene A'], values: ['Gene A'] }),
  };
  // Opened with no launch defaults.
  adapter._defaults = Object.freeze({});
  adapter._closed = false;
  adapter._lifecycleGeneration = 0;
  adapter._geneNamesByRoute = new Map();
  // The file opens on X named by its var index.
  adapter._candidates = {
    defaults: { expression: 'X', geneNames: 'index' },
    X: { n_vars: 1 },
    raw: null,
    layers: [],
    var: { n_vars: 1, columns: [] },
  };
  adapter._obsFieldsMetadata = [
    { key: 'score', kind: 'continuous' },
    { key: 'cluster', kind: 'category', categories: ['A', 'B'], palette: null },
  ];

  const rawObs = adapter.getObsFields();
  assert.deepEqual(rawObs, {
    n_points: 2,
    outlier_min_points: 10,
    stored_outlier_latent_key: null,
    latent_key: null,
    fields: [
      { key: 'score', kind: 'continuous', fieldIndex: 0, outlierQuantilesPath: null },
      {
        key: 'cluster',
        kind: 'category',
        fieldIndex: 1,
        categories: ['A', 'B'],
        codesDtype: 'uint8',
        codesMissingValue: 255,
        palette: null,
        outlierQuantilesPath: null,
      },
    ],
  });

  const checkedObs = checkObsFields(rawObs);
  const categorical = checkedObs.fields[1];
  assert.equal(categorical.outlierQuantilesPath, null);
  assert.equal(
    Object.hasOwn(categorical, 'outlierMinValue'),
    false
  );

  assert.equal(Object.hasOwn(categorical, 'centroidsByEmbedding'), false, 'centroids are computed in the browser');

  const rawVar = await adapter.getGeneList();
  assert.equal(Object.hasOwn(rawVar, 'var_gene_id_column'), false);
  assert.deepEqual(rawVar.geneNames, { source: null, filledFromIndex: 0, renamed: [] });
  const checkedVar = checkGeneList(rawVar);
  assert.deepEqual(
    checkedVar.fields,
    [{
      key: 'Gene A',
      kind: 'continuous',
      path: 'var/0',
    }]
  );
  assert.deepEqual(checkedVar.geneNames.names, ['Gene A']);
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
    'h5ad://strict-current/obs',
    checkObsFields(currentObsFields({
      continuous: [],
      outlierQuantilesPath: null,
      categorical: [{ key: 'label', categories: ['A', 'B'], codesDtype: 'uint8', codesMissingValue: 255 }],
    })).fields[0]
  );
  assert.deepEqual(Array.from(result.codes), [0, 1]);
  assert.equal(
    Object.hasOwn(result, 'outlierQuantiles'),
    false
  );
});

test('field names follow the display-text rule every DataState inventory read applies', async () => {
  const { StateValidator } = await import('../assets/js/app/utils/state-validator.js');
  for (const name of ['cell_type ', ' cell_type', 'cell​type', 'cell\ttype']) {
    assert.throws(() => StateValidator.validateFieldKey(name));
    assert.throws(
      () => checkObsFields(currentObsFields({ continuous: [name] })),
      /obs field list: field name .* cannot be displayed exactly/
    );
    assert.throws(
      () => checkGeneList(currentGeneList({ names: [name] })),
      /gene list: field name .* cannot be displayed exactly/
    );
  }
  // Drawable names the writers publish stay accepted, however long.
  const long = 'g'.repeat(400);
  for (const name of ['chr1:100-200', long]) {
    assert.equal(
      checkObsFields(currentObsFields({ continuous: [name] }))
        .fields[0].key,
      name
    );
    assert.equal(
      checkGeneList(currentGeneList({ names: [name] })).fields[0].key,
      name
    );
  }
});

test('category labels the writers publish are valid at any length', async () => {
  const { StateValidator } = await import('../assets/js/app/utils/state-validator.js');
  assert.equal(StateValidator.validateCategoryLabel('L'.repeat(300)), true);
});

