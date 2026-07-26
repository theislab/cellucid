import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { getDataSourceManager } from '../assets/js/data/data-source-manager.js';
import {
  VectorFieldManager,
  createVectorFieldManager,
} from '../assets/js/data/vector-field-manager.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function dimensionManager({
  positions = new Float32Array([0, 0, 0, 1, 1, 0]),
  scale = 2,
} = {}) {
  return {
    async getPositions3D(dimension) {
      assert.equal(dimension, 2);
      return positions;
    },
    getNormTransform(dimension) {
      assert.equal(dimension, 2);
      return { center: [0, 0, 0], scale };
    },
  };
}

function field(label, filename) {
  return {
    label,
    basis: 'umap',
    available_dimensions: [2],
    default_dimension: 2,
    files: { '2d': filename },
  };
}

function metadata(defaultField = null) {
  return {
    default_field: defaultField,
    fields: {
      beta_umap: field('Beta', 'vectors/beta_umap_2d.bin'),
      alpha_umap: field('Alpha', 'vectors/alpha_umap_2d.bin'),
    },
  };
}

function directMetadata() {
  return {
    default_field: 'velocity_umap',
    fields: {
      velocity_umap: {
        label: 'Velocity (UMAP)',
        basis: 'umap',
        available_dimensions: [2],
        default_dimension: 2,
        obsm_keys: { '2d': 'velocity_umap_2d' },
      },
    },
  };
}

test('vector metadata preserves an explicit nullable default without first-field selection', () => {
  const manager = createVectorFieldManager({
    baseUrl: 'https://example.test/dataset/',
    vectorFieldsMetadata: metadata(null),
    dimensionManager: dimensionManager(),
  });

  assert.equal(manager.hasAny(), true);
  assert.equal(manager.getDefaultFieldId(), null);
  assert.deepEqual(
    manager.getAvailableFields().map(({ id }) => id),
    ['alpha_umap', 'beta_umap']
  );
  assert.equal(manager.hasField('alpha_umap'), true);
  assert.equal(manager.hasField('missing_umap'), false);
  assert.equal(manager.hasFieldDimension('alpha_umap', 2), true);
  assert.equal(manager.hasFieldDimension('alpha_umap', 3), false);
  assert.throws(() => manager.hasField(7), /non-empty string/);
  assert.throws(
    () => manager.hasFieldDimension('alpha_umap', 2.8),
    /exactly 1, 2, or 3/
  );
});

test('vector manager requires the sole exact constructor and metadata shape', () => {
  assert.throws(
    () => new VectorFieldManager(),
    /plain object/
  );
  assert.throws(
    () => new VectorFieldManager({
      baseUrl: 'https://example.test/dataset/',
      vectorFieldsMetadata: null,
      dimensionManager: dimensionManager(),
      legacyMetadata: {},
    }),
    /unsupported key "legacyMetadata"/
  );
  assert.throws(
    () => new VectorFieldManager({
      baseUrl: 'https://example.test/dataset',
      vectorFieldsMetadata: null,
      dimensionManager: dimensionManager(),
    }),
    /ending in/
  );
  assert.throws(
    () => new VectorFieldManager({
      baseUrl: 'https://example.test/dataset/',
      vectorFieldsMetadata: {
        default_field: 'missing_umap',
        fields: {
          alpha_umap: field('Alpha', 'vectors/alpha_umap_2d.bin'),
        },
      },
      dimensionManager: dimensionManager(),
    }),
    /null or name a declared field/
  );
  assert.throws(
    () => new VectorFieldManager({
      baseUrl: 'https://example.test/dataset/',
      vectorFieldsMetadata: {
        default_field: null,
        fields: {
          alpha_umap: {
            ...field('Alpha', 'vectors/alpha_umap_2d.bin'),
            components: { '2d': 2 },
          },
        },
      },
      dimensionManager: dimensionManager(),
    }),
    /unsupported key "components"/
  );
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
    const manager = new VectorFieldManager({
      baseUrl: 'https://example.test/dataset/',
      vectorFieldsMetadata: metadata(null),
      dimensionManager: dimensionManager(),
    });
    const scaled = await manager.loadField(
      'alpha_umap',
      2,
      { showProgress: false }
    );
    assert.deepEqual(Array.from(scaled.vectors), [6, 8, 0, 0]);
    assert.equal(scaled.components, 2);
    assert.equal(scaled.cellCount, 2);
    assert.equal(scaled.maxMagnitude, 10);

    const zero = await manager.loadField(
      'beta_umap',
      2,
      { showProgress: false }
    );
    assert.deepEqual(Array.from(zero.vectors), [0, 0, 0, 0]);
    assert.equal(zero.maxMagnitude, 0);
    assert.deepEqual(requestedUrls, [
      'https://example.test/dataset/vectors/alpha_umap_2d.bin',
      'https://example.test/dataset/vectors/beta_umap_2d.bin',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    dataSourceManager.activeSource = previousSource;
  }
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
    const manager = new VectorFieldManager({
      baseUrl: 'https://example.test/dataset/',
      vectorFieldsMetadata: metadata(null),
      dimensionManager: dimensionManager(),
    });
    await assert.rejects(
      manager.loadField(
        'alpha_umap',
        2,
        { showProgress: false }
      ),
      /non-finite value at cell 0, component 0/
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
  const adapter = {
    async getVectorField(fieldId, dimension) {
      assert.equal(fieldId, 'velocity_umap');
      assert.equal(dimension, 2);
      return new Float32Array([1, 2, 3, 4]);
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
    const manager = new VectorFieldManager({
      baseUrl: 'h5ad://vector-direct/',
      vectorFieldsMetadata: directMetadata(),
      dimensionManager: dimensionManager(),
    });
    const result = await manager.loadField(
      'velocity_umap',
      2,
      { showProgress: false }
    );
    assert.deepEqual(Array.from(result.vectors), [2, 4, 6, 8]);
    assert.equal(result.maxMagnitude, 10);
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
    async getVectorField() {
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
    const manager = new VectorFieldManager({
      baseUrl: 'h5ad://vector-old/',
      vectorFieldsMetadata: directMetadata(),
      dimensionManager: dimensionManager(),
    });
    const pending = manager.loadField(
      'velocity_umap',
      2,
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
    /const defaultField = ids\.length === 1 \? ids\[0\] : null;/
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
