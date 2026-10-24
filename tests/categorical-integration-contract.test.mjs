import { createInMemoryDimensionManager } from '../assets/js/data/dimension-manager.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { DataLayer } from '../assets/js/app/analysis/data/data-layer.js';
import { GenesPanelController } from '../assets/js/app/analysis/genes-panel/genes-panel-controller.js';
import { DataState } from '../assets/js/app/state/core/data-state.js';
import { FieldOverlayInternalMethods } from '../assets/js/app/state/managers/field/overlay-internals.js';
import { viewContextViewerSyncMethods } from '../assets/js/app/state/managers/view-context-viewer-sync.js';
import { getFieldRegistry } from '../assets/js/app/utils/field-registry.js';
import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import { loaderMetadata, withObsmPayloads } from './helpers/anndata-mapping-mocks.mjs';
import {
  createObsFieldLoader,
  createVarFieldLoader,
  checkObsFields,
  checkGeneList,
  loadObsFieldData
} from '../assets/js/data/data-loaders.js';
import { getDataSourceManager } from '../assets/js/data/data-source-manager.js';
import { narrowCategoricalCodes } from '../assets/js/data/categorical-storage-contract.js';

function datasetMetadata(nObs) {
  // The private adapter-construction descriptor a loader returns; the public
  // identity is built from it by finalizeDirectIdentity(). Every fixture
  // carries one plottable 2D X_umap.
  return loaderMetadata({ nObs, obsm: { X_umap: 2 } });
}

/** `readObsmColumns` of that X_umap: cell `i` sits at `(i, -i)`. */
async function diagonalObsmColumns(key, columns) {
  assert.equal(key, 'X_umap');
  const values = new Float64Array(this.nObs * columns.length);
  for (let cell = 0; cell < this.nObs; cell++) {
    columns.forEach((column, index) => {
      values[cell * columns.length + index] = column === 0 ? cell : -cell;
    });
  }
  return values;
}

function categoricalLoader({
  categories,
  codes = Int32Array.from([0]),
  fieldKey = 'group'
}) {
  return withObsmPayloads({
    nObs: codes.length,
    nVars: 0,
    obsKeys: [fieldKey],
    varNames: [],
    readObsmColumns: diagonalObsmColumns,
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
      // As the reader worker answers: codes narrowed to the page's storage.
      return {
        dtype: 'categorical',
        categories,
        codes: narrowCategoricalCodes(codes, categories.length, `Categorical observation field '${key}'`)
      };
    }
  });
}

function metadataOnlyLoader(obsKeys, getObsFieldInfo, getObsField = null) {
  return withObsmPayloads({
    nObs: 1,
    nVars: 0,
    obsKeys,
    varNames: [],
    readObsmColumns: diagonalObsmColumns,
    async getDatasetMetadata() {
      return datasetMetadata(this.nObs);
    },
    getObsFieldInfo,
    getObsField: getObsField ?? (async () => {
      throw new Error('observation payload must remain lazy');
    })
  });
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

test('a category dictionary past the uint16 width is accepted and stored as uint32', async () => {
  const categories = Array.from({ length: 65_536 }, (_, index) => `category-${index}`);
  const adapter = new BaseAnnDataAdapter(categoricalLoader({ categories }));
  await adapter.initialize().catch(error => {
    assert.doesNotMatch(error.message, /categories|at most 65,535/i);
  });
});

test('shared adapter requires unique category labels by exact primitive identity', async t => {
  for (const [name, categories] of [
    ['string', ['same', 'same']],
    ['number', [7, 7]],
    ['boolean', [false, false]]
  ]) {
    await t.test(name, async () => {
      const adapter = new BaseAnnDataAdapter(
        categoricalLoader({ categories, codes: Int32Array.from([0, 1]) })
      );
      // The dictionary is read, and refused, with the field's first load.
      await adapter.initialize();
      await assert.rejects(
        adapter.getObsFieldData('group'),
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
  const field = await adapter.getObsFieldData('group');
  assert.deepEqual(field.categories, distinct);
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
  const adapter = new BaseAnnDataAdapter(withObsmPayloads(loader));

  await adapter.initialize();
  const field = await adapter.getObsFieldData('flag');

  assert.deepEqual(field.categories, [false, true]);
  assert.deepEqual(
    Array.from(new Uint8Array(field.data)),
    [0, 1, 0, 255]
  );
});

test('category dictionaries of every field load with no cumulative ceiling', async () => {
  const loader = metadataOnlyLoader(
    ['first', 'second'],
    async () => ({
      dtype: 'categorical',
      categories: ['one', 'two']
    })
  );
  const adapter = new BaseAnnDataAdapter(withObsmPayloads(loader), {
    cacheBudgetBytes: 0
  });
  // Initialization goes on to the embedding check, past every dictionary.
  await assert.rejects(adapter.initialize(), error => !/browser limit|working set/i.test(error.message));
});

test('primitive category discovery keeps every distinct label past 65,535', () => {
  const values = Array.from({ length: 70_000 }, (_, index) => `category-${index}`);
  const adapter = new BaseAnnDataAdapter(metadataOnlyLoader(['label'], async () => ({ dtype: 'string' })));
  const categories = adapter._discoverPrimitiveCategories(values, 'label');
  assert.equal(categories.length, 70_000);
});

test('a string column is read only when it is loaded: its categories are found then, and its payload released', async () => {
  let releaseCalls = 0;
  let reads = 0;
  const loader = metadataOnlyLoader(
    ['label'],
    async () => ({ dtype: 'string' }),
    async () => {
      reads++;
      return { dtype: 'string', values: ['b', 'a', null] };
    }
  );
  loader.nObs = 3;
  loader.releaseObsField = () => {
    releaseCalls++;
  };
  const adapter = new BaseAnnDataAdapter(withObsmPayloads(loader));
  await adapter.initialize();
  assert.equal(reads, 0, 'opening reads no obs value');
  assert.deepEqual(
    adapter.getObsFields().fields,
    [{
      key: 'label',
      kind: 'category',
      fieldIndex: 0,
      categories: null,
      codesDtype: null,
      codesMissingValue: null,
      palette: null,
      outlierQuantilesPath: null,
    }],
    'its categories and code width are found when it is loaded'
  );

  const field = await adapter.getObsFieldData('label');
  assert.deepEqual(field.categories, ['a', 'b']);
  assert.equal(field.dtype, 'uint8');
  assert.deepEqual(Array.from(new Uint8Array(field.data)), [1, 0, field.missingValue]);
  assert.equal(reads, 1);
  assert.equal(releaseCalls, 1);
  // A later load codes the column the same way.
  const again = await adapter.getObsFieldData('label');
  assert.deepEqual(again.categories, ['a', 'b']);
});

test('lazy observation payloads are evicted by the cache budget, never refused', async () => {
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
  loader.close = () => {};
  const adapter = new BaseAnnDataAdapter(withObsmPayloads(loader), {
    cacheBudgetBytes: 2000
  });
  await adapter.initialize();
  adapter._cacheBudgetBytes = 200n;

  await adapter.getObsFieldData('first');
  await adapter.getObsFieldData('second');
  assert.equal(adapter._obsFieldDataCache.size, 1);
  assert.ok(adapter._obsFieldDataCacheBytes <= 200n);

  // A payload larger than the whole budget is still returned.
  adapter._cacheBudgetBytes = 1n;
  adapter.clearCaches();
  assert.equal(adapter._obsFieldDataCacheBytes, 0n);
  assert.ok(await adapter.getObsFieldData('first'));
  assert.equal(adapter.getObsFields().n_points, 40);

  adapter.close();
  assert.equal(adapter._obsFieldDataCacheBytes, 0n);
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
  const adapter = new BaseAnnDataAdapter(withObsmPayloads(loader));
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

  // The width is the dictionary's, known once the field is first loaded.
  const listed = adapter.getObsFields().fields[0];
  assert.equal(listed.codesDtype, null);

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

  // The width is the dictionary's, known once the field is first loaded.
  const listed = adapter.getObsFields().fields[0];
  assert.equal(listed.codesDtype, null);

  const field = await adapter.getObsFieldData('group');
  assert.equal(field.dtype, 'uint8');
  assert.equal(field.missingValue, 255);
  assert.deepEqual(
    Array.from(new Uint8Array(field.data)),
    [254, 255]
  );
});

test('keeps adapter uint8 codes in their declared width with the uint8 missing sentinel', async () => {
  const adapter = new BaseAnnDataAdapter(categoricalLoader({
    categories: ['present'],
    codes: Int32Array.from([0, -1])
  }));
  await adapter.initialize();

  const field = checkObsFields(adapter.getObsFields()).fields[0];
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
      'zarr://missing-sentinel/obs',
      field
    );
    // One byte a cell: the runtime reads the missing code from the array's
    // own storage, so nothing is widened to two bytes on load.
    assert.ok(loaded.codes instanceof Uint8Array);
    assert.deepEqual(Array.from(loaded.codes), [0, 255]);
  } finally {
    restoreActiveDataset(manager, previous);
  }
});

test('a malformed string or boolean column fails when it is loaded, not the dataset open', async () => {
  const invalidPayload = new Error('invalid boolean payload byte 2');
  const loader = {
    nObs: 2,
    nVars: 0,
    obsKeys: ['bad_bool'],
    varNames: [],
    readObsmColumns: diagonalObsmColumns,
    async getDatasetMetadata() {
      return datasetMetadata(2);
    },
    async getObsFieldInfo() {
      return { dtype: 'bool' };
    },
    async getObsField() {
      throw invalidPayload;
    }
  };
  const adapter = new BaseAnnDataAdapter(withObsmPayloads(loader));

  await adapter.initialize();
  await assert.rejects(adapter.getObsFieldData('bad_bool'), error => error === invalidPayload);
});

test('rejects fields whose dtype is not in the current contract', async () => {
  const loader = {
    nObs: 1,
    nVars: 0,
    obsKeys: ['opaque'],
    varNames: [],
    readObsmColumns: diagonalObsmColumns,
    async getDatasetMetadata() {
      return datasetMetadata(1);
    },
    async getObsFieldInfo() {
      return { dtype: 'unknown' };
    }
  };
  const adapter = new BaseAnnDataAdapter(withObsmPayloads(loader));

  await assert.rejects(
    adapter.initialize(),
    /opaque.*unsupported dtype.*unknown/i
  );
});

function categoricalFieldList(field) {
  return {
    n_points: 1,
    outlier_min_points: 10,
    stored_outlier_latent_key: null,
    latent_key: null,
    fields: [{ key: 'label', kind: 'category', fieldIndex: 0, palette: null, outlierQuantilesPath: null, ...field }],
  };
}

test('rejects unsupported listed categorical code dtypes', () => {
  assert.throws(
    () => checkObsFields(categoricalFieldList({ categories: ['A'], codesDtype: 'uint64', codesMissingValue: 0xffff_ffff })),
    /unsupported categorical codes dtype.*uint64.*uint8.*uint16.*uint32/i
  );
});

test('a categorical field may leave its categories to its first load, all three together', () => {
  const [field] = checkObsFields(
    categoricalFieldList({ categories: null, codesDtype: null, codesMissingValue: null })
  ).fields;
  assert.equal(field.categories, null);
  assert.equal(field.codesDtype, null);
  assert.equal(field.codesMissingValue, null);
  // All three are found together, or none is.
  assert.throws(
    () => checkObsFields(categoricalFieldList({ categories: null, codesDtype: 'uint8', codesMissingValue: 255 })),
    /categories must be an array/i
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
          data: new BigUint64Array([0n, 1n]).buffer,
          kind: 'category',
          categories: ['A', 'B'],
          dtype: 'uint64',
          missingValue: 0xffff_ffff
        };
      }
    })
  };
  manager.activeDatasetId = 'unsupported-dtype';

  try {
    await assert.rejects(
      loadObsFieldData('zarr://unsupported-dtype/obs', {
        key: 'group',
        kind: 'category',
        fieldIndex: 0,
        categories: ['A', 'B'],
        codesDtype: 'uint8',
        codesMissingValue: 255,
        palette: null,
        outlierQuantilesPath: null,
      }),
      /unsupported categorical codes dtype.*uint64.*uint8.*uint16.*uint32/i
    );
  } finally {
    restoreActiveDataset(manager, previous);
  }
});

test('rejects source categorical codes before narrowing can alter them', () => {
  for (const invalidCode of [256, 0.5, -2, 1]) {
    assert.throws(
      () => narrowCategoricalCodes(Float64Array.from([invalidCode, 0]), 1, 'group'),
      /invalid code.*index 0.*expected -1 or an integer/i
    );
  }
  assert.deepEqual(Array.from(narrowCategoricalCodes(Int32Array.from([0, -1]), 1, 'group')), [0, 255]);
  const wide = narrowCategoricalCodes(Int32Array.from([300, -1]), 301, 'group');
  assert.ok(wide instanceof Uint16Array);
  assert.deepEqual(Array.from(wide), [300, 65_535]);
});

test('an adapter refuses codes that did not arrive narrowed to the field\'s storage', async () => {
  const loader = categoricalLoader({ categories: ['present'], codes: Int32Array.from([0, -1]) });
  loader.getObsField = async () => ({
    dtype: 'categorical',
    categories: ['present'],
    codes: Int32Array.from([0, -1]),
  });
  const adapter = new BaseAnnDataAdapter(withObsmPayloads(loader));
  await adapter.initialize();
  await assert.rejects(adapter.getObsFieldData('group'), /must arrive as narrowed codes/);
});

test('mutable state owns a writable copy of immutable loader categories', () => {
  const loaderCategories = Object.freeze([false, true]);
  let pageChangeCount = 0;
  const state = {
    _deleteRegistry: {
      clear() {},
      getRevision() {
        return 0;
      },
      editsSince() {
        return [];
      },
      hasEntriesFor() {
        return false;
      },
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
      getRevision() {
        return 0;
      },
      editsSince() {
        return [];
      },
      hasEntriesFor() {
        return false;
      },
      getDisplayCategory(_source, _key, label) {
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
    // The live view shows one 2D representation: positions carry 2 values a cell.
    dimensionManager: {
      getLayout: () => ({ layoutKey: 'X_umap', dimension: 2 })
    },
    clearCentroids() {},
    getViewLayoutKey: () => 'X_umap',
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
  state._applyCategoryOverlay = FieldOverlayInternalMethods.prototype._applyCategoryOverlay;
  state._applyOverlayToField = FieldOverlayInternalMethods.prototype._applyOverlayToField;
  assert.doesNotThrow(() => {
    FieldOverlayInternalMethods.prototype._applyOverlaysToFields.call(
      state,
      state.obsData.fields,
      'obs'
    );
  });
});

test('dataset publication retires stale field and batch owners before notifying UI', () => {
  const observed = [];
  const state = {
    _batchDepth: 2,
    _batchDirty: {
      visibility: true,
      colors: true,
      affectedFields: new Set([{ key: 'old' }]),
    },
    _batchMode: true,
    _deleteRegistry: { clear() {} },
    _fieldDataCache: new Map(),
    _renameRegistry: { clear() {} },
    _userDefinedFields: { clear() {} },
    _varFieldDataCache: new Map(),
    // The live view shows one 2D representation: positions carry 2 values a cell.
    dimensionManager: {
      getLayout: () => ({ layoutKey: 'X_umap', dimension: 2 })
    },
    getViewLayoutKey: () => 'X_umap',
    activeFieldIndex: 0,
    activeFieldSource: 'obs',
    activeVarFieldIndex: 3,
    clearCentroids() {},
    _notifyHighlightPageChange() {
      observed.push({
        activeFieldIndex: this.activeFieldIndex,
        activeFieldSource: this.activeFieldSource,
        activeVarFieldIndex: this.activeVarFieldIndex,
        batchDepth: this._batchDepth,
        batchMode: this._batchMode,
      });
    },
    _resetViewContexts() {},
    viewer: {
      resetVectorFieldOverlay() {},
      setCentroidLabels() {},
      setCentroids() {},
      setData() {},
    },
  };

  viewContextViewerSyncMethods.initScene.call(
    state,
    new Float32Array(6),
    {
      fields: [{
        categories: ['new-a', 'new-b'],
        key: 'new-group',
        kind: 'category',
      }],
    },
  );

  assert.deepEqual(observed, [{
    activeFieldIndex: -1,
    activeFieldSource: null,
    activeVarFieldIndex: -1,
    batchDepth: 0,
    batchMode: false,
  }]);
  assert.equal(state._activeCategoryCounts, null);
  assert.equal(Object.hasOwn(state, '_visibilityScratch'), false);
  assert.deepEqual(state._batchDirty, {
    visibility: false,
    colors: false,
    affectedFields: new Set(),
  });
});

async function prepareFalsyCategoryIntegration() {
  const categories = [0, false, 'other'];
  const adapter = new BaseAnnDataAdapter(categoricalLoader({
    categories,
    codes: Int32Array.from([0, 1, 2, 0, 1, 2])
  }));
  await adapter.initialize();

  const obsFields = checkObsFields(adapter.getObsFields());
  const field = obsFields.fields[0];
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
    'zarr://categorical-contract/obs',
    field
  );
  assert.deepEqual(Array.from(loaded.codes), [0, 1, 2, 0, 1, 2]);
  return {
    adapter,
    categories,
    loaded,
    manager,
    obsFields,
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
          },
          getDataMapping: () => ({
            kind: 'anndata',
            embeddings: {
              enabled: [{ key: 'X_umap', columns: [0, 1] }],
              defaults: { '1d': null, '2d': { key: 'X_umap', columns: [0, 1] }, '3d': null },
            },
            knn: null,
            geneNames: 'index',
            expression: 'X',
            log1p: {},
            highlyVariable: null,
            latent: null,
            vectorFields: [],
          })
        },
        async ensureObsFieldLoaded() {
          // The data layer hands analysis its uint16 form of the codes
          // (65535 = missing), whatever width the field loaded in.
          return {
            kind: 'category',
            categories,
            codes: Uint16Array.from(
              loaded.codes,
              code => (code === 255 ? 65_535 : code)
            ),
            colors: {}
          };
        }
      }
    });
    const grouped = await controller.describeGroups('group', null);
    assert.deepEqual(
      grouped.groups.map(group => group.groupName),
      [0, false, 'other']
    );
    assert.deepEqual(grouped.groups.map(group => group.count), [2, 2, 2]);
    assert.deepEqual(grouped.groups.map(group => group.optionId), ['0', 'false', 'other']);
  } finally {
    controller?.close();
    restoreActiveDataset(manager, previous);
  }
});

test('bulk analysis page values preserve numeric zero and false labels', async () => {
  const integration = await prepareFalsyCategoryIntegration();
  const {
    categories,
    loaded,
    manager,
    obsFields,
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
    // Analysis reads observation fields through `DataState.ensureFieldLoaded`,
    // which is what registers it as an independent lease on a shared field.
    // This stands in for that loader: it publishes the already-fetched codes
    // onto the descriptor exactly as DataState does.
    const fields = obsFields.fields.map(field => ({ ...field }));
    const state = {
      pointCount: 6,
      obsData: { fields },
      async ensureFieldLoaded(fieldIndex) {
        const field = fields[fieldIndex];
        field.kind = 'category';
        field.categories = categories;
        field.codes = loaded.codes;
        field.colors = {};
        field.loaded = true;
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
    });
    const { codes } = bulk.fields.group.all;
    assert.deepEqual(
      Array.from(codes, code => bulk.fields.group.categories[code]),
      [0, false, 'other', 0, false, 'other']
    );
  } finally {
    dataLayer?.destroy();
    restoreActiveDataset(manager, previous);
  }
});

function createStateForFieldLoading() {
  const state = new DataState({
    resetVectorFieldOverlay() {},
    setCentroidLabels() {},
    setCentroids() {},
    setData() {}
  }, null);
  // The two-cell 3D layout every scene in these tests publishes.
  state.setDimensionManager(createInMemoryDimensionManager({
    positions: new Float32Array(6),
    dimension: 3
  }));
  return state;
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
      readObsmColumns: diagonalObsmColumns,
      async getDatasetMetadata() {
        return loaderMetadata({ nObs: 2, nVars: 1, obsm: { X_umap: 2 }, hasX: true });
      },
      async readVarNames(axis, column) {
        assert.deepEqual([axis, column], ['X', null]);
        return { index: ['Gene A'], values: ['Gene A'] };
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
            codes: Uint8Array.from([0, 1])
          };
        }
        return {
          dtype: 'float',
          values: Float32Array.from([1.25, 2.5])
        };
      },
      async getMatrixColumn(element, index) {
        assert.deepEqual([element, index], ['X', 0]);
        return Float32Array.from([5.5, 6.75]);
      }
    };
    const adapter = new BaseAnnDataAdapter(withObsmPayloads(directLoader));
    await adapter.initialize();

    manager.activeSource = {
      datasetId: 'state-descriptor-direct',
      getType: () => 'zarr',
      getAdapter: () => adapter
    };
    manager.activeDatasetId = 'state-descriptor-direct';
    manager.activeDatasetMetadata = adapter.getMetadata();

    const obs = checkObsFields(adapter.getObsFields());
    const state = createStateForFieldLoading();
    state.setFieldLoader(createObsFieldLoader(
      'zarr://state-descriptor-direct/obs'
    ));
    state.setVarFieldLoader(createVarFieldLoader(
      'zarr://state-descriptor-direct/var'
    ));
    state.initVarData(checkGeneList(await adapter.getGeneList()));
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
    assert.ok(runtimeCategory._normalizedLayouts instanceof Set);
    assert.equal(runtimeCategory._normalizedLayouts.size, 0);
    assert.equal(Object.isFrozen(ownedCategoryDescriptor), true);
    // Its dictionary is read with its first load, not when the file opens.
    assert.equal(ownedCategoryDescriptor.categories, null);
    assert.equal(runtimeCategory.categories, null);
    assert.equal(Object.hasOwn(ownedCategoryDescriptor, 'loaded'), false);
    assert.equal(
      Object.hasOwn(ownedCategoryDescriptor, '_loadingPromise'),
      false
    );
    assert.equal(
      Object.hasOwn(ownedCategoryDescriptor, '_normalizedLayouts'),
      false
    );

    const loadedCategory = await state.ensureFieldLoaded(
      categoricalIndex,
      { silent: true }
    );
    assert.deepEqual(runtimeCategory.categories, [10, 20]);
    // The runtime field owns a copy: renaming in the UI leaves the immutable
    // descriptor as the file published it.
    runtimeCategory.categories[0] = 'renamed in UI';
    assert.equal(ownedCategoryDescriptor.categories, null);
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
});
