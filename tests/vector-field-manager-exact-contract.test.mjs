import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { getDataSourceManager } from '../assets/js/data/data-source-manager.js';
import {
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

/**
 * The registered layouts of the dimension manager stand-in: each is keyed by
 * its embedding id and records the `obsm` array and columns it plots.
 */
const UMAP_ITEMS = Object.freeze({
  X_umap: { dimension: 2, source: { key: 'X_umap', columns: [0, 1] } },
});

// Several embeddings per dimension.
const MULTI_ITEMS = Object.freeze({
  X_pca: { dimension: 2, source: { key: 'X_pca', columns: [0, 1] } },
  X_umap: { dimension: 2, source: { key: 'X_umap', columns: [0, 1] } },
  X_umap_3d: { dimension: 3, source: { key: 'X_umap_3d', columns: [0, 1, 2] } },
});

function dimensionManager({
  // Two cells of a 2D embedding: two components each.
  positions = new Float32Array([0, 0, 1, 1]),
  scale = 2,
  items = UMAP_ITEMS,
  positionsByLayout = null,
} = {}) {
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

/**
 * An AnnData file with `X_umap` (obsm 0) and `velocity_umap` (obsm 1) of
 * two cells, shown with its default mapping: `velocity_umap` is bound to
 * `X_umap` columns [0, 1], whose layout is `X_umap`.
 */
function directCandidates(obsm = { X_umap: 2, velocity_umap: 2 }) {
  return assembleAnnDataCandidates(
    describeAnnDataProbes(mappingProbes({ nObs: 2, obsm })),
    { slots: { '1d': null, '2d': { key: 'X_umap', columns: [0, 1] }, '3d': null }, guessed: [] }
  );
}

const DIRECT_VECTOR_ROUTE = 'vectors/1/0-1/0/0-1';

/** A mapping of `candidates` that binds exactly `bindings` (`[key, embeddingKey, columns]`). */
function mappingWith(candidates, bindings) {
  return validateDataMapping({
    ...candidates.defaults,
    vectorFields: sortVectorBindings(
      bindings.map(([key, embeddingKey, columns]) => ({ key, embedding: { key: embeddingKey, columns } })),
    ),
  });
}

/** The options of a manager over an AnnData file's mapping. */
function managerOptions({
  obsm = { X_umap: 2, alpha: 2, beta: 2 },
  bindings = [['alpha', 'X_umap', [0, 1]], ['beta', 'X_umap', [0, 1]]],
  items = UMAP_ITEMS,
  manager = dimensionManager({ items }),
  baseUrl = 'h5ad://vector-direct/',
} = {}) {
  const candidates = directCandidates(obsm);
  return {
    baseUrl,
    vectorFields: resolveVectorFields({
      mapping: mappingWith(candidates, bindings),
      candidates,
      dimensionManager: manager,
    }),
    dimensionManager: manager,
  };
}

function directManagerOptions(baseUrl) {
  const candidates = directCandidates();
  const manager = dimensionManager();
  return {
    baseUrl,
    vectorFields: resolveVectorFields({
      mapping: candidates.defaults,
      candidates,
      dimensionManager: manager,
    }),
    dimensionManager: manager,
  };
}

/** Run `body` with an active h5ad source whose adapter is `adapter`. */
async function withActiveAdapter(adapter, body, datasetId = 'vector-direct') {
  const dataSourceManager = getDataSourceManager();
  const previous = {
    activeSource: dataSourceManager.activeSource,
    activeDatasetId: dataSourceManager.activeDatasetId,
  };
  dataSourceManager.activeSource = {
    datasetId,
    getType: () => 'h5ad',
    getAdapter: () => adapter,
  };
  dataSourceManager.activeDatasetId = datasetId;
  try {
    return await body();
  } finally {
    dataSourceManager.activeSource = previous.activeSource;
    dataSourceManager.activeDatasetId = previous.activeDatasetId;
  }
}

/** The obsm index of a vector route (`vectors/{v}/...`). */
function vectorIndexOf(route) {
  return Number(/vectors\/(\d+)\//.exec(route)[1]);
}

test('vector fields list their bindings, with a default only when one field exists', () => {
  const manager = createVectorFieldManager(managerOptions());

  assert.equal(manager.hasAny(), true);
  assert.equal(manager.getDefaultFieldId(), null);
  assert.deepEqual(manager.getAvailableFields(), [
    { id: 'alpha', label: 'alpha', layoutKeys: ['X_umap'] },
    { id: 'beta', label: 'beta', layoutKeys: ['X_umap'] },
  ]);
  assert.equal(manager.hasField('alpha'), true);
  assert.equal(manager.hasField('missing'), false);
  assert.equal(manager.hasFieldLayout('alpha', 'X_umap'), true);
  // A dimension name is not a layout key.
  assert.equal(manager.hasFieldLayout('alpha', '2d'), false);
  assert.equal(manager.hasFieldLayout('alpha', 'X_umap_3d'), false);
  assert.throws(() => manager.hasField(7), /non-empty string/);
  assert.throws(
    () => manager.hasFieldLayout('alpha', 2),
    /layoutKey must be a non-empty string/
  );

  // The only field is the default.
  const one = createVectorFieldManager(managerOptions({ bindings: [['beta', 'X_umap', [0, 1]]] }));
  assert.equal(one.getDefaultFieldId(), 'beta');

  // A mapping without bindings has no field and no default.
  const none = createVectorFieldManager(managerOptions({ bindings: [] }));
  assert.equal(none.hasAny(), false);
  assert.equal(none.getDefaultFieldId(), null);
  assert.deepEqual(none.getAvailableFields(), []);
});

test('vector bindings name one layout per bound embedding, several per dimension', () => {
  const manager = createVectorFieldManager(managerOptions({
    obsm: { X_pca: 2, X_umap: 2, X_umap_3d: 3, velocity_umap: 2, velocity_umap_3d: 3 },
    bindings: [
      ['velocity_umap', 'X_umap', [0, 1]],
      ['velocity_umap_3d', 'X_umap_3d', [0, 1, 2]],
    ],
    items: MULTI_ITEMS,
  }));
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

test('vector manager requires the sole exact constructor shape', () => {
  assert.throws(
    () => new VectorFieldManager(),
    /plain object/
  );
  assert.throws(
    () => new VectorFieldManager({ ...managerOptions(), extra: {} }),
    /unsupported key "extra"/
  );
  {
    const { vectorFields: _vectorFields, ...withoutVectorFields } = managerOptions();
    assert.throws(
      () => new VectorFieldManager(withoutVectorFields),
      /vectorFields/
    );
  }
  // Anything but a resolved vector-field set is refused.
  for (const vectorFields of [
    { default_field: null, fields: {} },
    { defaultField: null, fields: { alpha: { label: 'alpha', files: { X_umap: DIRECT_VECTOR_ROUTE } } } },
    { defaultField: 'missing', fields: new Map() },
    null,
  ]) {
    assert.throws(
      () => new VectorFieldManager({ ...managerOptions(), vectorFields }),
      /vectorFields must come from resolveVectorFields\(\)/
    );
  }
  assert.throws(
    () => new VectorFieldManager({
      ...managerOptions(),
      baseUrl: 'h5ad://vector-direct',
    }),
    /ending in/
  );
  // The dimension manager must be able to say which layouts exist.
  const { hasLayout: _hasLayout, ...withoutHasLayout } = dimensionManager();
  assert.throws(
    () => new VectorFieldManager({
      ...managerOptions(),
      dimensionManager: withoutHasLayout,
    }),
    /must provide getPositions\(\), getNormTransform\(\), getLayout\(\), and hasLayout\(\)/
  );
  // Only an AnnData data mapping binds vector fields.
  assert.throws(
    () => resolveVectorFields({
      mapping: { kind: 'h5ad', vectorFields: [] },
      candidates: null,
      dimensionManager: dimensionManager(),
    }),
    /resolved from an AnnData data mapping/
  );
});

test('resolveVectorFields lists exactly the bindings the data mapping uses', () => {
  // An AnnData file: each binding is read through its mapping route, under
  // the layout the dimension manager registers for its embedding, and the
  // route is exactly what resolveVectorBinding() names.
  const candidates = directCandidates();
  const direct = resolveVectorFields({
    mapping: candidates.defaults,
    candidates,
    dimensionManager: dimensionManager(),
  });
  assert.equal(direct.defaultField, 'velocity');
  assert.deepEqual({ ...direct.fields.get('velocity') }, {
    label: 'velocity',
    files: { X_umap: DIRECT_VECTOR_ROUTE },
  });
  assert.equal(
    resolveVectorBinding(candidates, candidates.defaults.vectorFields[0]).path,
    DIRECT_VECTOR_ROUTE
  );
  // Two fields: no default is chosen for the user.
  const twoFields = directCandidates({ X_umap: 2, alpha: 2, velocity_umap: 2 });
  const twoMapping = validateDataMapping({
    ...twoFields.defaults,
    vectorFields: sortVectorBindings([
      { key: 'alpha', embedding: { key: 'X_umap', columns: [0, 1] } },
      { key: 'velocity_umap', embedding: { key: 'X_umap', columns: [0, 1] } },
    ]),
  });
  const two = resolveVectorFields({
    mapping: twoMapping,
    candidates: twoFields,
    dimensionManager: dimensionManager(),
  });
  assert.equal(two.defaultField, null);
  assert.deepEqual([...two.fields.keys()], ['alpha', 'velocity']);
  // The field the dataset opens with (a launch's vectorFieldDefault) is the
  // default when the mapping draws it; a field it does not draw is not.
  const launched = options => resolveVectorFields({
    mapping: twoMapping,
    candidates: twoFields,
    dimensionManager: dimensionManager(),
    ...options,
  }).defaultField;
  assert.equal(launched({ defaultField: 'alpha' }), 'alpha');
  assert.equal(launched({ defaultField: 'drift' }), null);
  assert.equal(
    resolveVectorFields({
      mapping: candidates.defaults,
      candidates,
      dimensionManager: dimensionManager(),
      defaultField: 'drift',
    }).defaultField,
    'velocity'
  );
  // A binding that cannot be drawn is refused by name, never dropped.
  const narrow = directCandidates({ X_umap: 2, velocity_umap: 3, wide: 5 });
  assert.throws(
    () => resolveVectorFields({
        mapping: validateDataMapping({
        ...narrow.defaults,
        vectorFields: [{ key: 'wide', embedding: { key: 'X_umap', columns: [0, 1] } }],
      }),
      candidates: narrow,
      dimensionManager: dimensionManager(),
    }),
    /Vector field obsm\['wide'\] cannot be drawn: obsm\['wide'\] has 5 columns/
  );
  // Two arrays that are one field of the same layout are refused:
  // `velocity_umap` is the field `velocity` on X_umap, and so is the array
  // `velocity` bound to it by hand.
  const twin = directCandidates({ X_umap: 2, velocity_umap: 2, velocity: 2 });
  assert.throws(
    () => resolveVectorFields({
        mapping: validateDataMapping({
        ...twin.defaults,
        vectorFields: sortVectorBindings([
          { key: 'velocity', embedding: { key: 'X_umap', columns: [0, 1] } },
          { key: 'velocity_umap', embedding: { key: 'X_umap', columns: [0, 1] } },
        ]),
      }),
      candidates: twin,
      dimensionManager: dimensionManager(),
    }),
    /Two vector arrays are the vector field "velocity" of X_umap; bind only one\./
  );
  // A bound embedding no layout plots is refused.
  assert.throws(
    () => resolveVectorFields({
        mapping: candidates.defaults,
      candidates,
      dimensionManager: { ...dimensionManager(), resolveProvenanceLayout: () => null },
    }),
    /bound to obsm\['X_umap'\], which cannot be plotted/
  );
});

test('a field is loaded per bound layout with that layout\'s own dimension and route', async () => {
  const reads = [];
  const adapter = {
    async getVectorPayload(route, dimension) {
      reads.push([route, dimension]);
      return dimension === 3
        ? { vectors: new Float32Array([1, 0, 0, 0, 2, 0]), maxMagnitude: 2 }
        : { vectors: new Float32Array([3, 4, 0, 0]), maxMagnitude: 5 };
    },
  };
  await withActiveAdapter(adapter, async () => {
    const options = managerOptions({
      obsm: { X_pca: 2, X_umap: 2, X_umap_3d: 3, velocity_umap: 2, velocity_umap_3d: 3 },
      bindings: [
        ['velocity_umap', 'X_umap', [0, 1]],
        ['velocity_umap_3d', 'X_umap_3d', [0, 1, 2]],
      ],
      items: MULTI_ITEMS,
      manager: dimensionManager({
        items: MULTI_ITEMS,
        positionsByLayout: {
          X_umap: new Float32Array([0, 0, 1, 1]),
          X_umap_3d: new Float32Array([0, 0, 0, 1, 1, 1]),
        },
      }),
    });
    const manager = new VectorFieldManager(options);
    const threeD = await manager.loadField('velocity', 'X_umap_3d');
    assert.equal(threeD.components, 3);
    assert.equal(threeD.cellCount, 2);
    assert.deepEqual(Array.from(threeD.vectors), [1, 0, 0, 0, 2, 0]);
    const twoD = await manager.loadField('velocity', 'X_umap');
    assert.equal(twoD.components, 2);
    assert.equal(twoD.maxMagnitude, 5);
    // Each read is the binding's own mapping route, at its layout's dimension.
    assert.deepEqual(reads.map(([route, dimension]) => [vectorIndexOf(route), dimension]), [[4, 3], [3, 2]]);
    await assert.rejects(
      manager.loadField('velocity', 'X_pca'),
      /field "velocity" declares no data for layout "X_pca"/
    );
    await assert.rejects(
      manager.loadField('missing', 'X_umap'),
      /unknown field "missing"/
    );
  });
});

test('vectors arrive scaled, with their largest magnitude, and are kept as they are', async () => {
  // The reader worker scaled them by their embedding's transform.
  const payloads = new Map([
    [1, { vectors: new Float32Array([3, 4, 0, 0]), maxMagnitude: 5 }],
    [2, { vectors: new Float32Array([0, 0, 0, 0]), maxMagnitude: 0 }],
  ]);
  const adapter = {
    async getVectorPayload(route) {
      return payloads.get(vectorIndexOf(route));
    },
  };
  await withActiveAdapter(adapter, async () => {
    const manager = new VectorFieldManager(managerOptions());
    const scaled = await manager.loadField('alpha', 'X_umap');
    assert.strictEqual(scaled.vectors, payloads.get(1).vectors);
    assert.deepEqual(Array.from(scaled.vectors), [3, 4, 0, 0]);
    assert.equal(scaled.components, 2);
    assert.equal(scaled.cellCount, 2);
    assert.equal(scaled.maxMagnitude, 5);

    const zero = await manager.loadField('beta', 'X_umap');
    assert.deepEqual(Array.from(zero.vectors), [0, 0, 0, 0]);
    assert.equal(zero.maxMagnitude, 0);
  });
});

test('disposing a vector manager aborts its in-flight read', async () => {
  let readSignal = null;
  let readStarted;
  const started = new Promise(resolve => {
    readStarted = resolve;
  });
  const adapter = {
    getVectorPayload(_route, _dimension, { signal }) {
      readSignal = signal;
      readStarted();
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
  await withActiveAdapter(adapter, async () => {
    const manager = new VectorFieldManager(managerOptions());
    const loading = manager.loadField('alpha', 'X_umap');
    await started;
    assert.ok(readSignal instanceof AbortSignal, 'the read must be abortable');
    manager.dispose();
    await assert.rejects(loading, error => error?.name === 'AbortError');
    assert.equal(readSignal.aborted, true);
    await assert.rejects(
      manager.loadField('beta', 'X_umap'),
      error => error?.name === 'AbortError',
    );
  });
});

test('the vector manager makes no pass over the vectors', () => {
  // Checking, scaling and the largest magnitude are the reader worker's
  // (data/embedding-payload.js); the page keeps what arrives.
  const source = VectorFieldManager.prototype._loadExactField.toString();
  assert.doesNotMatch(source, /for \(let /);
  assert.doesNotMatch(source, /new Float32Array\(/);
});

test('a vector payload without a finite largest magnitude is refused', async () => {
  const adapter = {
    async getVectorPayload() {
      return { vectors: new Float32Array([0, 1, 2, 3]), maxMagnitude: Number.NaN };
    },
  };
  await withActiveAdapter(adapter, async () => {
    const manager = new VectorFieldManager(managerOptions());
    await assert.rejects(
      manager.loadField('alpha', 'X_umap'),
      /field "alpha" must carry a finite non-negative largest magnitude/
    );
  });
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
      return { vectors: loaderOwned, maxMagnitude: 5 };
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
    // `velocity_umap` is listed as the field `velocity`, bound to the
    // layout `X_umap`, and is the default as the only field.
    assert.equal(manager.getDefaultFieldId(), 'velocity');
    assert.equal(manager.hasFieldLayout('velocity', 'X_umap'), true);
    const result = await manager.loadField('velocity', 'X_umap');
    assert.deepEqual(reads, [[DIRECT_VECTOR_ROUTE, 2]]);
    // The adapter's scaled array, shared read-only, never copied.
    assert.strictEqual(result.vectors, loaderOwned);
    assert.deepEqual(Array.from(result.vectors), [1, 2, 3, 4]);
    assert.equal(result.maxMagnitude, 5);
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
      return { vectors: new Float32Array([1, 2, 3, 4]), maxMagnitude: 5 };
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
    const pending = manager.loadField('velocity', 'X_umap');
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
