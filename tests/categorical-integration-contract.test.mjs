import assert from 'node:assert/strict';
import test from 'node:test';

import { DataLayer } from '../assets/js/app/analysis/data/data-layer.js';
import { GenesPanelController } from '../assets/js/app/analysis/genes-panel/genes-panel-controller.js';
import { DataState } from '../assets/js/app/state/core/data-state.js';
import { FieldOverlayInternalMethods } from '../assets/js/app/state/managers/field/overlay-internals.js';
import { viewContextViewerSyncMethods } from '../assets/js/app/state/managers/view-context-viewer-sync.js';
import { getFieldRegistry } from '../assets/js/app/utils/field-registry.js';
import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import {
  createObsFieldLoader,
  createVarFieldLoader,
  expandObsManifest,
  expandVarManifest,
  loadObsFieldData
} from '../assets/js/data/data-loaders.js';
import { getDataSourceManager } from '../assets/js/data/data-source-manager.js';

function datasetMetadata(nObs) {
  return {
    version: 2,
    id: 'categorical-contract',
    name: 'categorical-contract',
    stats: {
      n_cells: nObs,
      n_genes: 0
    },
    embeddings: {
      available_dimensions: [],
      default_dimension: null,
      obsm_keys: {}
    }
  };
}

function categoricalLoader({
  categories,
  codes = Int32Array.from([0]),
  fieldKey = 'group'
}) {
  return {
    nObs: codes.length,
    nVars: 0,
    obsKeys: [fieldKey],
    varNames: [],
    obsmKeys: [],
    async getDatasetMetadata() {
      return datasetMetadata(codes.length);
    },
    async getObsFieldInfo(key) {
      assert.equal(key, fieldKey);
      return {
        dtype: 'categorical',
        categories
      };
    },
    async getObsField(key) {
      assert.equal(key, fieldKey);
      return {
        dtype: 'categorical',
        categories,
        codes
      };
    }
  };
}

function metadataOnlyLoader(obsKeys, getObsFieldInfo, getObsField = null) {
  return {
    nObs: 1,
    nVars: 0,
    obsKeys,
    varNames: [],
    obsmKeys: [],
    async getDatasetMetadata() {
      return datasetMetadata(1);
    },
    getObsFieldInfo,
    getObsField: getObsField ?? (async () => {
      throw new Error('observation payload must remain lazy');
    })
  };
}

function saveActiveDataset(manager) {
  return {
    activeSource: manager.activeSource,
    activeDatasetId: manager.activeDatasetId,
    activeDatasetMetadata: manager.activeDatasetMetadata
  };
}

function restoreActiveDataset(manager, previous) {
  manager.activeSource = previous.activeSource;
  manager.activeDatasetId = previous.activeDatasetId;
  manager.activeDatasetMetadata = previous.activeDatasetMetadata;
}

test('rejects category dictionaries larger than the uint16 sentinel contract', async () => {
  const categories = new Array(65_536).fill('category');
  const adapter = new BaseAnnDataAdapter(categoricalLoader({ categories }));

  await assert.rejects(
    adapter.initialize(),
    /65,536 categories.*at most 65,535.*reduce or merge/i
  );
});

test('shared adapter requires unique category labels by exact primitive identity', async t => {
  for (const [name, categories] of [
    ['string', ['same', 'same']],
    ['number', [7, 7]],
    ['boolean', [false, false]]
  ]) {
    await t.test(name, async () => {
      const adapter = new BaseAnnDataAdapter(
        categoricalLoader({ categories })
      );
      await assert.rejects(
        adapter.initialize(),
        /categorical observation field.*group.*duplicate.*label/i
      );
    });
  }

  const distinct = [0, false, '0'];
  const adapter = new BaseAnnDataAdapter(categoricalLoader({
    categories: distinct,
    codes: Int32Array.from([0, 1, 2])
  }));
  await adapter.initialize();
  assert.deepEqual(
    adapter.getObsManifest()._categoricalFields[0][1],
    distinct
  );
});

test('primitive boolean discovery and code conversion preserve boolean identity', async () => {
  const loader = metadataOnlyLoader(
    ['flag'],
    async () => ({ dtype: 'bool' }),
    async () => ({
      dtype: 'bool',
      values: [false, true, false, null]
    })
  );
  loader.nObs = 4;
  const adapter = new BaseAnnDataAdapter(loader);

  await adapter.initialize();
  const field = await adapter.getObsFieldData('flag');

  assert.deepEqual(field.categories, [false, true]);
  assert.deepEqual(
    Array.from(new Uint8Array(field.data)),
    [0, 1, 0, 255]
  );
});

test('bounds cumulative retained observation categories across fields', async () => {
  const loader = metadataOnlyLoader(
    ['first', 'second'],
    async () => ({
      dtype: 'categorical',
      categories: ['one', 'two']
    })
  );
  const adapter = new BaseAnnDataAdapter(loader, {
    maxMaterializedBytes: 200
  });

  await assert.rejects(
    adapter.initialize(),
    /cumulative observation metadata.*browser limit/i
  );
});

test('primitive category discovery stops at the portable ceiling and releases payloads', async () => {
  let highestRead = -1;
  let released = 0;
  const values = new Proxy(
    { length: 1_000_000 },
    {
      get(target, property) {
        if (property === 'filter') {
          throw new Error('copy-heavy filter path sentinel');
        }
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          const index = Number(property);
          highestRead = Math.max(highestRead, index);
          if (index < 65_536) return `category-${index}`;
          throw new Error('category discovery read beyond ceiling');
        }
        return Reflect.get(target, property);
      }
    }
  );
  const field = { dtype: 'string', values };
  const loader = metadataOnlyLoader(
    ['label'],
    async () => ({ dtype: 'string' }),
    async () => field
  );
  loader.nObs = values.length;
  loader.releaseObsField = (key, expected) => {
    assert.equal(key, 'label');
    assert.strictEqual(expected, field);
    released++;
  };
  const adapter = new BaseAnnDataAdapter(loader);

  await assert.rejects(
    adapter.initialize(),
    /65,536 categories.*at most 65,535.*reduce or merge/i
  );
  assert.equal(highestRead, 65_535);
  assert.equal(released, 1);
});

test('primitive loader payloads are released after discovery and code conversion', async () => {
  let releaseCalls = 0;
  const loader = metadataOnlyLoader(
    ['label'],
    async () => ({ dtype: 'string' }),
    async () => ({ dtype: 'string', values: ['b', 'a', null] })
  );
  loader.nObs = 3;
  loader.releaseObsField = () => {
    releaseCalls++;
  };
  const adapter = new BaseAnnDataAdapter(loader);
  await adapter.initialize();
  assert.equal(releaseCalls, 1);

  const field = await adapter.getObsFieldData('label');
  assert.deepEqual(field.categories, ['a', 'b']);
  assert.equal(releaseCalls, 2);
});

test('bounds lazy observation intermediates by retained bytes', async () => {
  const valuesByKey = {
    first: new Float32Array(40),
    second: new Float32Array(40)
  };
  const loader = metadataOnlyLoader(
    Object.keys(valuesByKey),
    async () => ({ dtype: 'float' }),
    async key => ({ dtype: 'float', values: valuesByKey[key] })
  );
  loader.nObs = 40;
  loader.getDatasetMetadata = async () => datasetMetadata(40);
  loader.close = () => {};
  const adapter = new BaseAnnDataAdapter(loader, {
    maxMaterializedBytes: 200
  });
  await adapter.initialize();

  await adapter.getObsFieldData('first');
  await adapter.getObsFieldData('second');
  assert.equal(adapter._obsFieldDataCache.size, 1);
  assert.ok(adapter._obsFieldDataCacheBytes <= 200n);

  const metadataBytes = adapter._obsMetadataRetainedBytes;
  adapter.clearCaches();
  assert.equal(adapter._obsFieldDataCacheBytes, 0n);
  assert.equal(adapter._obsMetadataRetainedBytes, metadataBytes);
  assert.equal(adapter.getObsManifest().n_points, 40);

  adapter.close();
  assert.equal(adapter._obsFieldDataCacheBytes, 0n);
  assert.equal(adapter._obsMetadataRetainedBytes, 0n);
  assert.equal(adapter._obsFieldsMetadata, null);
});

test('primitive code maps build without a full categories.map temporary', async () => {
  const categories = new Proxy(
    ['a', 'b'],
    {
      get(target, property, receiver) {
        if (property === 'map') {
          throw new Error('categories.map temporary sentinel');
        }
        return Reflect.get(target, property, receiver);
      }
    }
  );
  const loader = {
    nObs: 3,
    async getObsField() {
      return {
        dtype: 'string',
        values: ['b', 'a', null]
      };
    }
  };
  const adapter = new BaseAnnDataAdapter(loader);
  adapter._metadata = datasetMetadata(3);
  adapter._obsFieldsMetadata = [{
    key: 'label',
    kind: 'category',
    categories,
    _needsCodeComputation: true
  }];

  const field = await adapter.getObsFieldData('label');
  assert.deepEqual(Array.from(new Uint8Array(field.data)), [1, 0, 255]);
  assert.equal(adapter._obsFieldDataCache.size, 0);
});

test('preflights primitive category map and code workspace before traversal', async () => {
  let valueReads = 0;
  const values = new Proxy(
    { length: 3 },
    {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          valueReads++;
          throw new Error('primitive category value sentinel');
        }
        return Reflect.get(target, property, receiver);
      }
    }
  );
  const loader = {
    nObs: 3,
    async getObsField() {
      return { dtype: 'string', values };
    }
  };
  const adapter = new BaseAnnDataAdapter(loader, {
    maxMaterializedBytes: 450
  });
  adapter._metadata = datasetMetadata(3);
  adapter._obsFieldsMetadata = [{
    key: 'label',
    kind: 'category',
    categories: ['a', 'b'],
    _needsCodeComputation: true
  }];
  // Two retained one-character category labels:
  // 2 array references + 2 × (estimated object + UTF-16 payload).
  adapter._obsMetadataRetainedBytes = 148n;

  await assert.rejects(
    adapter.getObsFieldData('label'),
    /category conversion.*working set.*server or prepared format/i
  );
  assert.equal(valueReads, 0);
  assert.equal(adapter._obsFieldDataCache.size, 0);
});

test('keeps the exact 65,535-category boundary on uint16 without uint32 output', async () => {
  const categories = Array.from(
    { length: 65_535 },
    (_, index) => `category-${index}`
  );
  const adapter = new BaseAnnDataAdapter(categoricalLoader({
    categories,
    codes: Int32Array.from([65_534, -1])
  }));
  await adapter.initialize();

  const compactField = adapter.getObsManifest()._categoricalFields[0];
  assert.equal(compactField[2], 'uint16');
  assert.equal(compactField[3], 65_535);

  const field = await adapter.getObsFieldData('group');
  assert.equal(field.dtype, 'uint16');
  assert.equal(field.missingValue, 65_535);
  assert.deepEqual(
    Array.from(new Uint16Array(field.data)),
    [65_534, 65_535]
  );
});

test('keeps the exact 255-category boundary on uint8', async () => {
  const categories = Array.from(
    { length: 255 },
    (_, index) => `category-${index}`
  );
  const adapter = new BaseAnnDataAdapter(categoricalLoader({
    categories,
    codes: Int32Array.from([254, -1])
  }));
  await adapter.initialize();

  const compactField = adapter.getObsManifest()._categoricalFields[0];
  assert.equal(compactField[2], 'uint8');
  assert.equal(compactField[3], 255);

  const field = await adapter.getObsFieldData('group');
  assert.equal(field.dtype, 'uint8');
  assert.equal(field.missingValue, 255);
  assert.deepEqual(
    Array.from(new Uint8Array(field.data)),
    [254, 255]
  );
});

test('canonicalizes adapter uint8 missing codes to the uint16 sentinel', async () => {
  const adapter = new BaseAnnDataAdapter(categoricalLoader({
    categories: ['present'],
    codes: Int32Array.from([0, -1])
  }));
  await adapter.initialize();

  const field = expandObsManifest(adapter.getObsManifest()).fields[0];
  const manager = getDataSourceManager();
  const previous = saveActiveDataset(manager);
  manager.activeSource = {
    datasetId: 'missing-sentinel',
    getType: () => 'zarr',
    getAdapter: () => adapter
  };
  manager.activeDatasetId = 'missing-sentinel';

  try {
    const loaded = await loadObsFieldData(
      'zarr://missing-sentinel/obs/manifest.json',
      field
    );
    assert.ok(loaded.codes instanceof Uint16Array);
    assert.deepEqual(Array.from(loaded.codes), [0, 65_535]);
  } finally {
    restoreActiveDataset(manager, previous);
  }
});

test('propagates supported observation-field validation failures during initialize', async () => {
  const invalidPayload = new Error('invalid boolean payload byte 2');
  const loader = {
    nObs: 1,
    nVars: 0,
    obsKeys: ['bad_bool'],
    varNames: [],
    obsmKeys: [],
    async getDatasetMetadata() {
      return datasetMetadata(1);
    },
    async getObsFieldInfo() {
      return { dtype: 'bool' };
    },
    async getObsField() {
      throw invalidPayload;
    }
  };
  const adapter = new BaseAnnDataAdapter(loader);

  await assert.rejects(adapter.initialize(), error => error === invalidPayload);
});

test('rejects fields whose dtype is not in the current contract', async () => {
  const loader = {
    nObs: 1,
    nVars: 0,
    obsKeys: ['opaque'],
    varNames: [],
    obsmKeys: [],
    async getDatasetMetadata() {
      return datasetMetadata(1);
    },
    async getObsFieldInfo() {
      return { dtype: 'unknown' };
    }
  };
  const adapter = new BaseAnnDataAdapter(loader);

  await assert.rejects(
    adapter.initialize(),
    /opaque.*unsupported dtype.*unknown/i
  );
});

test('rejects unsupported compact categorical code dtypes', () => {
  const compactManifest = {
    _format: 'compact_v1',
    n_points: 1,
    centroid_outlier_quantile: 0.95,
    latent_key: 'latent_space',
    compression: null,
    _obsSchemas: {
      categorical: {
        codesPathPattern: 'obs/{key}.codes.{ext}',
        outlierPathPattern: 'obs/{key}.outliers.f32',
        outlierExt: 'f32',
        outlierDtype: 'float32',
        outlierQuantized: false
      }
    },
    _continuousFields: [],
    _categoricalFields: [
      ['group', ['A'], 'uint32', 0xffff_ffff, {}]
    ]
  };
  assert.throws(
    () => expandObsManifest(compactManifest),
    /unsupported categorical codes dtype.*uint32.*uint8.*uint16/i
  );
});

test('rejects unsupported direct AnnData categorical code dtypes', async () => {
  const manager = getDataSourceManager();
  const previous = saveActiveDataset(manager);
  manager.activeSource = {
    datasetId: 'unsupported-dtype',
    getType: () => 'zarr',
    getAdapter: () => ({
      async getObsFieldData() {
        return {
          data: Uint32Array.from([0, 1]).buffer,
          kind: 'category',
          categories: ['A', 'B'],
          dtype: 'uint32',
          missingValue: 0xffff_ffff
        };
      }
    })
  };
  manager.activeDatasetId = 'unsupported-dtype';

  try {
    await assert.rejects(
      loadObsFieldData('zarr://unsupported-dtype/obs/manifest.json', {
        key: 'group',
        kind: 'category',
        categories: ['A', 'B'],
        codesPath: 'obs/group.codes.u8',
        codesDtype: 'uint8',
        codesMissingValue: 255,
        outlierQuantilesPath: null,
        outlierDtype: null,
        outlierQuantized: false,
        centroidsByDim: {},
      }),
      /unsupported categorical codes dtype.*uint32.*uint8.*uint16/i
    );
  } finally {
    restoreActiveDataset(manager, previous);
  }
});

test('rejects source categorical codes before narrowing can alter them', async () => {
  for (const invalidCode of [256, 0.5, -2]) {
    const adapter = new BaseAnnDataAdapter(categoricalLoader({
      categories: ['present'],
      codes: Float64Array.from([invalidCode])
    }));
    await adapter.initialize();
    await assert.rejects(
      adapter.getObsFieldData('group'),
      /invalid code.*index 0.*expected -1 or an integer/i
    );
  }
});

test('mutable state owns a writable copy of immutable loader categories', () => {
  const loaderCategories = Object.freeze([false, true]);
  let pageChangeCount = 0;
  const state = {
    _deleteRegistry: {
      clear() {},
      isDeleted() {
        return false;
      },
      isPurged() {
        return false;
      }
    },
    _fieldDataCache: new Map(),
    _renameRegistry: {
      clear() {},
      getDisplayCategory(_source, _key, _index, label) {
        return label;
      },
      getDisplayKey(_source, key) {
        return key;
      }
    },
    _notifyHighlightPageChange() {
      pageChangeCount += 1;
    },
    _resetViewContexts() {},
    _syncCentroidCategoryLabels() {},
    _userDefinedFields: {
      clear() {}
    },
    _varFieldDataCache: new Map(),
    activeDimensionLevel: 2,
    clearCentroids() {},
    viewer: {
      resetVectorFieldOverlay() {},
      setCentroidLabels() {},
      setCentroids() {},
      setData() {}
    }
  };

  viewContextViewerSyncMethods.initScene.call(
    state,
    new Float32Array(6),
    {
      fields: [{
        categories: loaderCategories,
        key: 'group',
        kind: 'category'
      }]
    }
  );

  const stateCategories = state.obsData.fields[0].categories;
  assert.notStrictEqual(stateCategories, loaderCategories);
  assert.deepEqual(stateCategories, loaderCategories);
  assert.equal(pageChangeCount, 1);
  assert.doesNotThrow(() => {
    FieldOverlayInternalMethods.prototype._applyOverlaysToFields.call(
      state,
      state.obsData.fields,
      'obs'
    );
  });
});

async function prepareFalsyCategoryIntegration() {
  const categories = [0, false, 'other'];
  const adapter = new BaseAnnDataAdapter(categoricalLoader({
    categories,
    codes: Int32Array.from([0, 1, 2, 0, 1, 2])
  }));
  await adapter.initialize();

  const obsManifest = expandObsManifest(adapter.getObsManifest());
  const field = obsManifest.fields[0];
  const manager = getDataSourceManager();
  const previous = saveActiveDataset(manager);
  manager.activeSource = {
    datasetId: 'categorical-contract',
    getType: () => 'zarr',
    getAdapter: () => adapter
  };
  manager.activeDatasetId = 'categorical-contract';
  manager.activeDatasetMetadata = adapter.getMetadata();

  const loaded = await loadObsFieldData(
    'zarr://categorical-contract/obs/manifest.json',
    field
  );
  assert.deepEqual(Array.from(loaded.codes), [0, 1, 2, 0, 1, 2]);
  return {
    adapter,
    categories,
    loaded,
    manager,
    obsManifest,
    previous
  };
}

test('genes analysis preserves numeric zero and false category labels', async () => {
  const integration = await prepareFalsyCategoryIntegration();
  const {
    categories,
    loaded,
    manager,
    previous
  } = integration;
  let controller = null;
  try {
    controller = new GenesPanelController({
      dataLayer: {
        state: {
          obsData: {
            fields: [{ key: 'group', loaded: true }]
          }
        },
        async ensureObsFieldLoaded() {
          return {
            kind: 'category',
            categories,
            codes: loaded.codes,
            colors: {}
          };
        }
      }
    });
    const grouped = await controller.getGroupsAndCodes('group');
    assert.deepEqual(
      grouped.groups.map(group => group.groupName),
      [0, false, 'other']
    );
    assert.deepEqual(
      grouped.groups.map(group => Array.from(group.cellIndices)),
      [[0, 3], [1, 4], [2, 5]]
    );
  } finally {
    controller?.close();
    restoreActiveDataset(manager, previous);
  }
});

test('bulk analysis page values preserve numeric zero and false labels', async () => {
  const integration = await prepareFalsyCategoryIntegration();
  const {
    manager,
    obsManifest,
    previous
  } = integration;
  let dataLayer = null;
  try {
    const pages = [{
      id: 'all',
      name: 'All cells',
      highlightedGroups: [{
        enabled: true,
        cellIndices: [0, 1, 2, 3, 4, 5]
      }]
    }];
    const state = {
      pointCount: 6,
      manifestUrl: 'zarr://categorical-contract/obs/manifest.json',
      obsManifest,
      obsData: {
        fields: obsManifest.fields
      },
      getHighlightPages: () => pages
    };
    dataLayer = new DataLayer(state, {
      enableCache: false,
      enableDedup: false,
      enableVersionTracking: false,
      enableNotifications: false
    });
    const bulk = await dataLayer.fetchBulkObsFields({
      pageIds: ['all'],
      obsFields: ['group'],
      includeCategoricalValues: true
    });
    assert.deepEqual(
      bulk.fields.group.all.values,
      [0, false, 'other', 0, false, 'other']
    );
  } finally {
    dataLayer?.destroy();
    restoreActiveDataset(manager, previous);
  }
});

function createStateForFieldLoading() {
  return new DataState({
    resetVectorFieldOverlay() {},
    setCentroidLabels() {},
    setCentroids() {},
    setData() {}
  }, null);
}

test('DataState keeps exact field descriptors separate from mutable load state', async t => {
  const manager = getDataSourceManager();
  const previousDataset = saveActiveDataset(manager);
  const registry = getFieldRegistry();
  const previousRegistryState = registry._state;
  const originalFetch = globalThis.fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    restoreActiveDataset(manager, previousDataset);
    registry.bind(previousRegistryState);
  });

  await t.test('direct AnnData categorical and continuous selection', async () => {
    const directLoader = {
      nObs: 2,
      nVars: 1,
      obsKeys: ['numeric_category', 'score'],
      varNames: ['Gene A'],
      obsmKeys: [],
      async getDatasetMetadata() {
        return datasetMetadata(2);
      },
      async getObsFieldInfo(key) {
        if (key === 'numeric_category') {
          return {
            dtype: 'categorical',
            categories: [10, 20],
            ordered: false
          };
        }
        return { dtype: 'float' };
      },
      async getObsField(key) {
        if (key === 'numeric_category') {
          return {
            dtype: 'categorical',
            categories: [10, 20],
            codes: Int32Array.from([0, 1])
          };
        }
        return {
          dtype: 'float',
          values: Float32Array.from([1.25, 2.5])
        };
      },
      async getGeneExpression(key) {
        assert.equal(key, 'Gene A');
        return Float32Array.from([5.5, 6.75]);
      }
    };
    const adapter = new BaseAnnDataAdapter(directLoader);
    await adapter.initialize();

    manager.activeSource = {
      datasetId: 'state-descriptor-direct',
      getType: () => 'zarr',
      getAdapter: () => adapter
    };
    manager.activeDatasetId = 'state-descriptor-direct';
    manager.activeDatasetMetadata = adapter.getMetadata();

    const obs = expandObsManifest(adapter.getObsManifest());
    const state = createStateForFieldLoading();
    state.setFieldLoader(createObsFieldLoader(
      'zarr://state-descriptor-direct/obs/manifest.json'
    ));
    state.setVarFieldLoader(createVarFieldLoader(
      'zarr://state-descriptor-direct/var/manifest.json'
    ));
    state.initVarData(expandVarManifest(adapter.getVarManifest()));
    state.initScene(new Float32Array(6), obs);

    const categoricalIndex = state.obsData.fields.findIndex(
      field => field.key === 'numeric_category'
    );
    const continuousIndex = state.obsData.fields.findIndex(
      field => field.key === 'score'
    );
    const runtimeCategory = state.obsData.fields[categoricalIndex];
    const ownedCategoryDescriptor =
      state._obsFieldDescriptors[categoricalIndex];

    assert.equal(runtimeCategory.loaded, false);
    assert.equal(runtimeCategory._loadingPromise, null);
    assert.equal(runtimeCategory._normalizedDims, null);
    assert.equal(Object.isFrozen(ownedCategoryDescriptor), true);
    assert.equal(Object.isFrozen(ownedCategoryDescriptor.categories), true);
    assert.equal(Object.hasOwn(ownedCategoryDescriptor, 'loaded'), false);
    assert.equal(
      Object.hasOwn(ownedCategoryDescriptor, '_loadingPromise'),
      false
    );
    assert.equal(
      Object.hasOwn(ownedCategoryDescriptor, '_normalizedDims'),
      false
    );

    runtimeCategory.categories[0] = 'renamed in UI';
    assert.deepEqual(ownedCategoryDescriptor.categories, [10, 20]);

    const loadedCategory = await state.ensureFieldLoaded(
      categoricalIndex,
      { silent: true }
    );
    const loadedContinuous = await state.ensureFieldLoaded(
      continuousIndex,
      { silent: true }
    );
    const loadedGene = await state.ensureVarFieldLoaded(
      0,
      { silent: true }
    );
    assert.deepEqual(Array.from(loadedCategory.codes), [0, 1]);
    assert.deepEqual(Array.from(loadedContinuous.values), [1.25, 2.5]);
    assert.deepEqual(Array.from(loadedGene.values), [5.5, 6.75]);
  });

  await t.test('prepared categorical and continuous selection', async () => {
    manager.activeSource = null;
    manager.activeDatasetId = null;
    manager.activeDatasetMetadata = null;

    const obs = expandObsManifest({
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
          quantized: false
        },
        categorical: {
          codesPathPattern: 'obs/{key}.codes.{ext}',
          outlierPathPattern: null,
          outlierExt: null,
          outlierDtype: null,
          outlierQuantized: false
        }
      },
      _continuousFields: [['score']],
      _categoricalFields: [[
        'numeric_category',
        [10, 20],
        'uint8',
        255,
        {}
      ]]
    });

    globalThis.fetch = async url => {
      const path = String(url);
      if (path.endsWith('/obs/score.values.f32')) {
        return new Response(Float32Array.from([3.5, 4.75]));
      }
      if (path.endsWith('/obs/numeric_category.codes.u8')) {
        return new Response(Uint8Array.from([1, 0]));
      }
      if (path.endsWith('/var/Gene_A.values.f32')) {
        return new Response(Float32Array.from([8.25, 9.5]));
      }
      return new Response('not found', { status: 404 });
    };

    const state = createStateForFieldLoading();
    state.setFieldLoader(createObsFieldLoader(
      'https://example.test/obs_manifest.json'
    ));
    state.setVarFieldLoader(createVarFieldLoader(
      'https://example.test/var_manifest.json'
    ));
    state.initVarData(expandVarManifest({
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
        quantized: false
      },
      fields: [['Gene A']]
    }));
    state.initScene(new Float32Array(6), obs);

    const categoricalIndex = state.obsData.fields.findIndex(
      field => field.key === 'numeric_category'
    );
    const continuousIndex = state.obsData.fields.findIndex(
      field => field.key === 'score'
    );
    const loadedCategory = await state.ensureFieldLoaded(
      categoricalIndex,
      { silent: true }
    );
    const loadedContinuous = await state.ensureFieldLoaded(
      continuousIndex,
      { silent: true }
    );
    const loadedGene = await state.ensureVarFieldLoaded(
      0,
      { silent: true }
    );

    assert.deepEqual(Array.from(loadedCategory.codes), [1, 0]);
    assert.deepEqual(Array.from(loadedContinuous.values), [3.5, 4.75]);
    assert.deepEqual(Array.from(loadedGene.values), [8.25, 9.5]);
  });
});
