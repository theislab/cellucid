import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_COLORMAP_ID,
  sampleContinuousColormap,
} from '../assets/js/data/palettes.js';
import {
  UserDefinedFieldsRegistry,
} from '../assets/js/app/registries/user-defined-fields.js';
import {
  FieldCategoryOpsMethods,
} from '../assets/js/app/state/managers/field/category-ops.js';
import {
  FieldOverlayPublicMethods,
} from '../assets/js/app/state/managers/field/overlay-public.js';
import {
  DataStateColorMethods,
} from '../assets/js/app/state/managers/color-manager.js';
import {
  DataStateFilterMethods,
} from '../assets/js/app/state/managers/filter-manager.js';
import {
  highlightStateMethods,
} from '../assets/js/app/state/managers/highlight-manager.js';
import {
  viewContextCoreMethods,
} from '../assets/js/app/state/managers/view-context-core.js';
import {
  buildMergeTraversal,
} from '../assets/js/app/ui/modules/community-annotation-voting-modal.js';
import {
  CategoryBuilder,
} from '../assets/js/app/ui/category-builder.js';
import {
  FieldSource,
  OverlapStrategy,
} from '../assets/js/app/utils/field-constants.js';
import {
  applyCategoryIndexMapping,
  buildDeleteToUnassignedTransform,
  buildMergeCategoriesTransform,
} from '../assets/js/app/utils/categorical-ops.js';

function exactContinuousField(values) {
  return {
    key: 'score',
    kind: 'continuous',
    values,
    loaded: true,
  };
}

function exactCategoryMetadata(field) {
  field._categoryColors = field.categories.map((_, index) => (
    index === 0 ? [0.1, 0.2, 0.3] : [0.7, 0.8, 0.9]
  ));
  field._categoryVisible = Object.fromEntries(
    field.categories.map((_, index) => [index, true]),
  );
  field._categoryFilterEnabled = true;
  return field;
}

test('active-field lookup publishes null or one exact owned field', () => {
  const noSelection = Object.assign(
    Object.create(FieldOverlayPublicMethods.prototype),
    {
      activeFieldSource: null,
      activeFieldIndex: -1,
      activeVarFieldIndex: -1,
      obsData: { fields: [] },
      varData: { fields: [] },
    },
  );
  assert.equal(noSelection.getActiveField(), null);

  const obsField = { key: 'cell_type', kind: 'category' };
  const selected = Object.assign(
    Object.create(FieldOverlayPublicMethods.prototype),
    {
      activeFieldSource: FieldSource.OBS,
      activeFieldIndex: 0,
      activeVarFieldIndex: -1,
      obsData: { fields: [obsField] },
      varData: { fields: [] },
    },
  );
  assert.strictEqual(selected.getActiveField(), obsField);

  for (const corrupt of [
    { activeFieldSource: null, activeFieldIndex: 0 },
    { activeFieldSource: 'unknown' },
    { activeFieldSource: FieldSource.OBS, activeFieldIndex: -1 },
    { activeFieldSource: FieldSource.OBS, activeVarFieldIndex: 0 },
    { activeFieldSource: FieldSource.VAR, activeVarFieldIndex: 0 },
  ]) {
    const state = Object.assign(
      Object.create(FieldOverlayPublicMethods.prototype),
      {
        activeFieldSource: null,
        activeFieldIndex: -1,
        activeVarFieldIndex: -1,
        obsData: { fields: [obsField] },
        varData: { fields: [] },
      },
      corrupt,
    );
    assert.throws(() => state.getActiveField(), /active field|field source|field index/i);
  }
});

test('field overlay actions reject before mutation and preserve exact loader failures', async () => {
  const continuous = {
    key: 'score',
    kind: 'continuous',
    values: Float32Array.from([1, 2]),
    loaded: true,
  };
  const state = Object.assign(
    Object.create(FieldOverlayPublicMethods.prototype),
    {
      obsData: { fields: [continuous] },
      varData: { fields: [] },
    },
  );
  assert.throws(
    () => state.renameField('rows', 0, 'renamed'),
    /source.*exactly obs or var/i,
  );
  assert.equal(continuous.key, 'score');
  assert.equal(Object.hasOwn(continuous, '_originalKey'), false);

  let loadCalls = 0;
  const loadFailure = new Error('exact field load failure');
  state.ensureFieldLoaded = async () => {
    loadCalls += 1;
    throw loadFailure;
  };
  await assert.rejects(
    state.duplicateField(FieldSource.OBS, 0, { newKey: 'score_copy' }),
    error => error === loadFailure,
  );
  assert.equal(loadCalls, 1);
  assert.deepEqual(state.obsData.fields, [continuous]);

  loadCalls = 0;
  await assert.rejects(
    state.duplicateField(FieldSource.OBS, 0, {
      newKey: 'score_copy',
      retry: true,
    }),
    /unknown key "retry"/i,
  );
  assert.equal(loadCalls, 0);

  const deleted = {
    key: 'duplicate',
    kind: 'continuous',
    _isDeleted: true,
  };
  const visible = {
    key: 'duplicate',
    kind: 'continuous',
  };
  let restoreRegistryCalls = 0;
  const restoreState = Object.assign(
    Object.create(FieldOverlayPublicMethods.prototype),
    {
      obsData: { fields: [deleted, visible] },
      varData: { fields: [] },
      _deleteRegistry: {
        markRestored() {
          restoreRegistryCalls += 1;
        },
      },
    },
  );
  assert.throws(
    () => restoreState.restoreField(FieldSource.OBS, 0),
    /cannot restore.*visible field name exists/i,
  );
  assert.equal(deleted._isDeleted, true);
  assert.equal(restoreRegistryCalls, 0);
});

test('category builder treats zero cells as an exact disabled startup state', () => {
  const attributes = new Map();
  const classStates = new Map();
  const builder = Object.assign(
    Object.create(CategoryBuilder.prototype),
    {
      _initialized: true,
      _document: {},
      _view: {},
      _lifecycle: {},
      _state: { pointCount: 0 },
      _droppedPages: [{ pageId: 'stale' }],
      _isOpen: true,
      _els: {
        toggle: {
          disabled: false,
          setAttribute(name, value) {
            attributes.set(`toggle:${name}`, value);
          },
        },
        dropzone: {
          setAttribute(name, value) {
            attributes.set(`dropzone:${name}`, value);
          },
          classList: {
            toggle(name, value) {
              classStates.set(name, value);
            },
          },
        },
        item: {
          classList: {
            remove(name) {
              classStates.set(name, false);
            },
          },
        },
      },
      _renderDroppedItems() {
        this.renderCalls += 1;
      },
      _updatePreview() {
        this.previewCalls += 1;
      },
      renderCalls: 0,
      previewCalls: 0,
    },
  );

  builder._syncDatasetAvailability();
  assert.equal(builder._els.toggle.disabled, true);
  assert.equal(attributes.get('toggle:aria-disabled'), 'true');
  assert.equal(attributes.get('dropzone:aria-disabled'), 'true');
  assert.equal(classStates.get('disabled'), true);
  assert.deepEqual(builder._droppedPages, []);
  assert.equal(builder._isOpen, false);
  assert.equal(builder.renderCalls, 1);
  assert.equal(builder.previewCalls, 1);

  builder._state.pointCount = 7;
  builder._syncDatasetAvailability();
  assert.equal(builder._els.toggle.disabled, false);
  assert.equal(attributes.get('toggle:aria-disabled'), 'false');
  assert.equal(attributes.get('dropzone:aria-disabled'), 'false');
  assert.equal(classStates.get('disabled'), false);
  assert.equal(builder.renderCalls, 1);
  assert.equal(builder.previewCalls, 1);

  for (const invalid of [-1, 1.5, Number.NaN]) {
    builder._state.pointCount = invalid;
    assert.throws(
      () => builder._syncDatasetAvailability(),
      /non-negative pointCount/i,
    );
  }
});

test('category builder previews exact membership and rejects invalid draft labels without coercion', () => {
  const pages = new Map([
    ['a', {
      highlightedGroups: [{
        enabled: true,
        cellIndices: Uint32Array.from([0, 1, 2]),
      }],
    }],
    ['b', {
      highlightedGroups: [{
        enabled: true,
        cellIndices: Uint32Array.from([2, 3]),
      }],
    }],
  ]);
  const builder = Object.assign(
    Object.create(CategoryBuilder.prototype),
    {
      _state: { pointCount: 5 },
      _droppedPages: [
        { pageId: 'a', label: 'A' },
        { pageId: 'b', label: 'B' },
      ],
      _assertInitialized() {},
      _getPage(pageId) {
        return pages.get(pageId);
      },
    },
  );

  assert.deepEqual(
    builder._computePreview(OverlapStrategy.FIRST),
    {
      overlapCount: 1,
      uncoveredCount: 1,
      pageCounts: [3, 1],
      intersectionRows: [],
    },
  );
  assert.deepEqual(
    builder._computePreview(OverlapStrategy.INTERSECTIONS),
    {
      overlapCount: 1,
      uncoveredCount: 1,
      pageCounts: [2, 1],
      intersectionRows: [{ mask: 3, count: 1 }],
    },
  );

  builder._droppedPages[0].label = '';
  assert.match(
    builder._getPageLabelValidationError(),
    /Page 1.*non-empty trimmed label/i,
  );
  builder._droppedPages[0].label = ' A ';
  assert.match(
    builder._getPageLabelValidationError(),
    /Page 1.*non-empty trimmed label/i,
  );
  builder._droppedPages[0].label = 'A';
  assert.equal(builder._getPageLabelValidationError(), null);

  pages.get('b').highlightedGroups[0].cellIndices =
    Uint32Array.from([2, 5]);
  assert.throws(
    () => builder._computePreview(OverlapStrategy.FIRST),
    /out-of-range cell index/i,
  );
});

test('continuous color metadata preserves constant domains and rejects impossible log scale atomically', () => {
  const constantField = exactContinuousField(Float32Array.from([5, 5]));
  const colorState = Object.assign(
    Object.create(DataStateColorMethods.prototype),
    {
      pointCount: 2,
      colorsArray: new Uint8Array(8),
      categoryTransparency: Float32Array.from([1, 1]),
    },
  );

  colorState.updateColorsContinuous(constantField, {
    resetTransparency: false,
  });

  assert.deepEqual(constantField._continuousStats, { min: 5, max: 5 });
  assert.deepEqual(constantField._continuousFilter, { min: 5, max: 5 });
  assert.deepEqual(constantField._continuousColorRange, { min: 5, max: 5 });
  const expectedMidpoint = sampleContinuousColormap(DEFAULT_COLORMAP_ID, 0.5)
    .map(channel => Math.round(channel * 255));
  assert.deepEqual(Array.from(colorState.colorsArray.slice(0, 3)), expectedMidpoint);
  assert.deepEqual(Array.from(colorState.colorsArray.slice(4, 7)), expectedMidpoint);
  assert.deepEqual(
    [colorState.colorsArray[3], colorState.colorsArray[7]],
    [255, 255],
  );

  const nonpositiveField = {
    ...exactContinuousField(Float32Array.from([-2, 0])),
    _continuousStats: { min: -2, max: 0 },
    _continuousFilter: { min: -2, max: 0 },
    _continuousColorRange: { min: -2, max: 0 },
    _positiveStats: null,
    _useFilterColorRange: true,
    _useLogScale: false,
    _colormapId: DEFAULT_COLORMAP_ID,
    _filterEnabled: true,
  };
  const untouchedColors = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const logState = Object.assign(
    Object.create(DataStateColorMethods.prototype),
    {
      pointCount: 2,
      colorsArray: untouchedColors,
      categoryTransparency: Float32Array.from([1, 1]),
      getContinuousFieldRef() {
        return { field: nonpositiveField };
      },
    },
  );

  assert.throws(
    () => logState.setContinuousLogScale(0, true),
    /requires at least one positive/i,
  );
  assert.equal(nonpositiveField._useLogScale, false);
  assert.deepEqual(
    Array.from(logState.colorsArray),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );

  const inconsistentField = {
    ...exactContinuousField(Float32Array.from([1, 2])),
    _positiveStats: { min: 1, max: 3 },
  };
  assert.throws(
    () => colorState.ensureContinuousMetadata(inconsistentField),
    /positive statistics do not match/i,
  );
  assert.equal(inconsistentField._continuousStats, undefined);
  assert.equal(inconsistentField._continuousFilter, undefined);
  assert.equal(inconsistentField._continuousColorRange, undefined);
});

test('categorical color metadata rejects incomplete state without repairing it', () => {
  const state = Object.create(DataStateColorMethods.prototype);
  const incompleteColors = [[0.1, 0.2, 0.3]];
  const fieldWithIncompleteColors = {
    kind: 'category',
    categories: ['alpha', 'beta'],
    _categoryColors: incompleteColors,
    _categoryVisible: { 0: true, 1: true },
    _categoryFilterEnabled: true,
  };

  assert.throws(
    () => state.ensureCategoryMetadata(fieldWithIncompleteColors),
    /one RGB triplet per category/i,
  );
  assert.strictEqual(fieldWithIncompleteColors._categoryColors, incompleteColors);

  const incompleteVisibility = { 0: true };
  const fieldWithIncompleteVisibility = {
    kind: 'category',
    categories: ['alpha', 'beta'],
    _categoryColors: [[0.1, 0.2, 0.3], [0.7, 0.8, 0.9]],
    _categoryVisible: incompleteVisibility,
    _categoryFilterEnabled: true,
  };
  assert.throws(
    () => state.ensureCategoryMetadata(fieldWithIncompleteVisibility),
    /every category index exactly once/i,
  );
  assert.strictEqual(
    fieldWithIncompleteVisibility._categoryVisible,
    incompleteVisibility,
  );

  const malformedVisibilityWithoutColors = {
    kind: 'category',
    categories: ['alpha', 'beta'],
    _categoryVisible: { 0: true },
  };
  assert.throws(
    () => state.ensureCategoryMetadata(malformedVisibilityWithoutColors),
    /every category index exactly once/i,
  );
  assert.equal(malformedVisibilityWithoutColors._categoryColors, undefined);
  assert.equal(
    malformedVisibilityWithoutColors._categoryFilterEnabled,
    undefined,
  );

  const previousColors = Uint8Array.from([
    9, 8, 7, 6,
    5, 4, 3, 2,
  ]);
  const previousTransparency = Float32Array.from([0.25, 0.75]);
  const coloringState = Object.assign(
    Object.create(DataStateColorMethods.prototype),
    {
      pointCount: 2,
      colorsArray: previousColors,
      categoryTransparency: previousTransparency,
      _pushTransparencyToViewer() {},
      _syncActiveContext() {},
    },
  );
  const invalidCodeField = exactCategoryMetadata({
    kind: 'category',
    categories: ['alpha', 'beta'],
    codes: Uint8Array.from([0, 2]),
  });
  assert.throws(
    () => coloringState.updateColorsCategorical(invalidCodeField),
    /outside the category inventory/i,
  );
  assert.deepEqual(
    Array.from(coloringState.colorsArray),
    [9, 8, 7, 6, 5, 4, 3, 2],
  );
  assert.deepEqual(
    Array.from(coloringState.categoryTransparency),
    [0.25, 0.75],
  );
});

test('centroid construction rejects unknown categories before changing render buffers', () => {
  const previousPositions = Float32Array.from([9, 8, 7]);
  const previousColors = Uint8Array.from([1, 2, 3, 4]);
  const state = Object.assign(
    Object.create(DataStateColorMethods.prototype),
    {
      activeDimensionLevel: 2,
      activeViewId: 'live',
      centroidPositions: previousPositions,
      centroidColors: previousColors,
    },
  );
  const field = exactCategoryMetadata({
    kind: 'category',
    categories: ['alpha'],
    centroidsByDim: {
      2: [{
        category: 'unknown',
        position: [0, 1],
        n_points: 1,
      }],
    },
    _normalizedDims: new Set(),
  });

  assert.throws(
    () => state.buildCentroidsForField(field, { viewId: 'live' }),
    /unknown category/i,
  );
  assert.strictEqual(state.centroidPositions, previousPositions);
  assert.strictEqual(state.centroidColors, previousColors);
});

test('highlight selections require exact target-view transparency', () => {
  const state = {
    pointCount: 4,
    obsData: {
      fields: [
        {
          kind: 'category',
          categories: ['alpha', 'beta'],
          codes: Uint8Array.from([0, 1, 0, 0]),
        },
        {
          kind: 'continuous',
          values: Float32Array.from([0, 1, 2, 3]),
        },
      ],
    },
    varData: { fields: [] },
  };

  assert.throws(
    () => highlightStateMethods.getCellIndicesForCategory.call(
      state,
      0,
      0,
      FieldSource.OBS,
      undefined,
    ),
    /complete Float32Array transparency/i,
  );

  const transparency = Float32Array.from([1, 1, 0, 0.5]);
  assert.deepEqual(
    highlightStateMethods.getCellIndicesForCategory.call(
      state,
      0,
      0,
      FieldSource.OBS,
      transparency,
    ),
    [0, 3],
  );
  assert.deepEqual(
    highlightStateMethods.getCellIndicesForRange.call(
      state,
      1,
      1,
      3,
      FieldSource.OBS,
      transparency,
    ),
    [1, 3],
  );
});

test('observation filters compose across fields while cloned view state remains independent', () => {
  const categoryField = exactCategoryMetadata({
    key: 'cell_type',
    kind: 'category',
    categories: ['alpha', 'beta'],
    codes: Uint8Array.from([0, 1, 0, 1]),
    loaded: true,
  });
  categoryField._categoryVisible[1] = false;
  const continuousField = {
    ...exactContinuousField(Float32Array.from([0, 1, 2, 3])),
    _continuousStats: { min: 0, max: 3 },
    _continuousFilter: { min: 1, max: 2 },
    _continuousColorRange: { min: 0, max: 3 },
    _positiveStats: { min: 1, max: 3 },
    _useFilterColorRange: true,
    _useLogScale: false,
    _colormapId: DEFAULT_COLORMAP_ID,
    _filterEnabled: true,
  };
  const obsData = { fields: [categoryField, continuousField] };
  const state = Object.assign(
    Object.create(DataStateFilterMethods.prototype),
    {
      pointCount: 4,
      obsData,
      varData: { fields: [] },
      activeFieldSource: 'obs',
      activeFieldIndex: 1,
      activeVarFieldIndex: -1,
      categoryTransparency: new Float32Array(4),
      cellVisibilityMask: Float32Array.from([1, 1, 1, 1]),
      colorsArray: new Uint8Array(16),
      ensureCategoryMetadata:
        DataStateColorMethods.prototype.ensureCategoryMetadata,
      ensureContinuousMetadata:
        DataStateColorMethods.prototype.ensureContinuousMetadata,
      _syncColorsAlpha: DataStateColorMethods.prototype._syncColorsAlpha,
      isOutlierFilterEnabledForActiveField() {
        return false;
      },
      _updateActiveCategoryCounts() {
        return false;
      },
      _pushTransparencyToViewer() {},
      _syncActiveContext() {},
      updateFilteredCount() {},
      updateFilterSummary() {},
      _notifyVisibilityChange() {},
    },
  );

  state.computeGlobalVisibility();
  assert.deepEqual(Array.from(state.categoryTransparency), [0, 0, 1, 0]);

  const cloneOwner = {
    _cloneFieldState: viewContextCoreMethods._cloneFieldState,
  };
  const clonedObsData = viewContextCoreMethods._cloneObsData.call(
    cloneOwner,
    obsData,
  );
  clonedObsData.fields[0]._categoryVisible[0] = false;
  clonedObsData.fields[1]._continuousFilter.min = 2;
  assert.equal(obsData.fields[0]._categoryVisible[0], true);
  assert.equal(obsData.fields[1]._continuousFilter.min, 1);
});

test('an exact zero-cell observation generation owns valid empty visibility', () => {
  const state = Object.assign(
    Object.create(DataStateFilterMethods.prototype),
    {
      pointCount: 0,
      obsData: { count: 0, fields: [] },
      categoryTransparency: new Float32Array(),
      cellVisibilityMask: new Float32Array(),
      colorsArray: new Uint8Array(),
    },
  );

  assert.doesNotThrow(() => state.computeGlobalVisibility());

  state.obsData = { count: 0, fields: [{ key: 'impossible' }] };
  assert.throws(
    () => state.computeGlobalVisibility(),
    /exact empty observation generation/i,
  );
});

test('view switching restores cloned cell masks and rejects invalid targets atomically', () => {
  const pointCount = 4;
  const state = {
    pointCount,
    obsData: { fields: [] },
    varData: { fields: [] },
    activeFieldIndex: -1,
    activeVarFieldIndex: -1,
    activeFieldSource: null,
    activeDimensionLevel: 2,
    activeViewId: 'live',
    colorsArray: new Uint8Array(pointCount * 4),
    categoryTransparency: Float32Array.from([1, 1, 1, 1]),
    cellVisibilityMask: Float32Array.from([1, 1, 0, 1]),
    outlierQuantilesArray: Float32Array.from([-1, -1, -1, -1]),
    centroidPositions: new Float32Array(),
    centroidColors: new Uint8Array(),
    centroidOutliers: new Float32Array(),
    centroidLabels: [],
    filteredCount: { shown: 3, total: pointCount },
    viewContexts: new Map(),
    dimensionManager: null,
    viewer: {
      setViewLayout() {},
    },
    _cloneFieldState: viewContextCoreMethods._cloneFieldState,
    _cloneObsData: viewContextCoreMethods._cloneObsData,
    _cloneVarData: viewContextCoreMethods._cloneVarData,
    _buildContextFromCurrent: viewContextCoreMethods._buildContextFromCurrent,
    _syncActiveContext: viewContextCoreMethods._syncActiveContext,
    setActiveView: viewContextCoreMethods.setActiveView,
    clearSnapshotViews: viewContextCoreMethods.clearSnapshotViews,
    setCellVisibility: DataStateFilterMethods.prototype.setCellVisibility,
    computeGlobalVisibility:
      DataStateFilterMethods.prototype.computeGlobalVisibility,
    _syncColorsAlpha: DataStateColorMethods.prototype._syncColorsAlpha,
    _applyOverlaysToFields() {},
    _injectUserDefinedFields() {},
    _ensureActiveSelectionNotDeleted() {},
    _reinitializeActiveField() {},
    _rebuildLabelLayerFromCentroids() {},
    _pushColorsToViewer() {},
    _pushTransparencyToViewer() {},
    _pushOutliersToViewer() {},
    _pushCentroidsToViewer() {},
    _pushOutlierThresholdToViewer() {},
    getCurrentOutlierThreshold() {
      return 1;
    },
    isOutlierFilterEnabledForActiveField() {
      return false;
    },
    _updateActiveCategoryCounts() {
      return false;
    },
    updateFilteredCount() {},
    updateFilterSummary() {},
    _notifyVisibilityChange() {},
  };

  const liveMask = Float32Array.from(state.cellVisibilityMask);
  const liveContext = state._buildContextFromCurrent('live', {
    cloneArrays: true,
  });
  state.cellVisibilityMask = Float32Array.from([1, 0, 1, 1]);
  const snapshotContext = state._buildContextFromCurrent('snapshot-1', {
    cloneArrays: true,
  });
  state.cellVisibilityMask = Float32Array.from(liveMask);
  state.viewContexts.set('live', liveContext);
  state.viewContexts.set('snapshot-1', snapshotContext);

  assert.equal(state.setActiveView('snapshot-1'), 'snapshot-1');
  assert.deepEqual(Array.from(state.cellVisibilityMask), [1, 0, 1, 1]);
  assert.notStrictEqual(
    state.cellVisibilityMask,
    state.viewContexts.get('snapshot-1').cellVisibilityMask,
  );

  state.setCellVisibility([3], false);
  assert.deepEqual(Array.from(state.categoryTransparency), [1, 0, 1, 0]);
  assert.deepEqual(
    Array.from(state.viewContexts.get('snapshot-1').cellVisibilityMask),
    [1, 0, 1, 0],
  );

  assert.equal(state.setActiveView('live'), 'live');
  state.computeGlobalVisibility();
  assert.deepEqual(Array.from(state.cellVisibilityMask), [1, 1, 0, 1]);
  assert.deepEqual(Array.from(state.categoryTransparency), [1, 1, 0, 1]);

  assert.equal(state.setActiveView('snapshot-1'), 'snapshot-1');
  state.computeGlobalVisibility();
  assert.deepEqual(Array.from(state.cellVisibilityMask), [1, 0, 1, 0]);
  assert.deepEqual(Array.from(state.categoryTransparency), [1, 0, 1, 0]);

  const activeViewBeforeFailure = state.activeViewId;
  const activeMaskBeforeFailure = state.cellVisibilityMask;
  const activeMaskValuesBeforeFailure = Array.from(state.cellVisibilityMask);
  const liveContextMaskBeforeFailure =
    state.viewContexts.get('live').cellVisibilityMask;
  const snapshotContextMaskBeforeFailure =
    state.viewContexts.get('snapshot-1').cellVisibilityMask;

  assert.throws(
    () => state.setActiveView(''),
    /non-empty string/i,
  );
  assert.throws(
    () => state.setActiveView('missing-view'),
    /does not exist/i,
  );
  assert.throws(
    () => state.setActiveView(1),
    /non-empty string/i,
  );
  assert.equal(state.activeViewId, activeViewBeforeFailure);
  assert.strictEqual(state.cellVisibilityMask, activeMaskBeforeFailure);
  assert.deepEqual(
    Array.from(state.cellVisibilityMask),
    activeMaskValuesBeforeFailure,
  );
  assert.strictEqual(
    state.viewContexts.get('live').cellVisibilityMask,
    liveContextMaskBeforeFailure,
  );
  assert.strictEqual(
    state.viewContexts.get('snapshot-1').cellVisibilityMask,
    snapshotContextMaskBeforeFailure,
  );

  state.clearSnapshotViews();
  assert.equal(state.activeViewId, 'live');
  assert.deepEqual([...state.viewContexts.keys()], ['live']);
  assert.deepEqual(Array.from(state.cellVisibilityMask), [1, 1, 0, 1]);
  assert.deepEqual(Array.from(state.categoryTransparency), [1, 1, 0, 1]);
});

test('visibility preflight rejects corrupt codes before changing view transparency', () => {
  const categoryField = exactCategoryMetadata({
    key: 'cell_type',
    kind: 'category',
    categories: ['alpha', 'beta'],
    codes: Uint8Array.from([0, 2]),
    loaded: true,
  });
  categoryField._categoryVisible[1] = false;
  const previousTransparency = Float32Array.from([0.25, 0.75]);
  const state = Object.assign(
    Object.create(DataStateFilterMethods.prototype),
    {
      pointCount: 2,
      obsData: { fields: [categoryField] },
      varData: { fields: [] },
      activeFieldSource: null,
      activeFieldIndex: -1,
      activeVarFieldIndex: -1,
      categoryTransparency: previousTransparency,
      cellVisibilityMask: Float32Array.from([1, 1]),
      colorsArray: new Uint8Array(8),
      ensureCategoryMetadata:
        DataStateColorMethods.prototype.ensureCategoryMetadata,
      isOutlierFilterEnabledForActiveField() {
        return false;
      },
    },
  );

  assert.throws(
    () => state.computeGlobalVisibility(),
    /outside the category inventory/i,
  );
  assert.deepEqual(
    Array.from(state.categoryTransparency),
    [0.25, 0.75],
  );
});

test('category editing rejects non-typed codes before mutating its source field', () => {
  const sourceField = {
    key: 'cell_type',
    kind: 'category',
    categories: ['alpha', 'beta'],
    codes: [0, 1],
    _isDeleted: false,
    _isUserDefined: false,
  };
  const state = Object.assign(
    Object.create(FieldCategoryOpsMethods.prototype),
    {
      pointCount: 2,
      obsData: { fields: [sourceField] },
    },
  );

  assert.throws(
    () => state.deleteCategoryToUnassigned(0, 0, {
      editInPlace: false,
      unassignedLabel: 'unassigned',
    }),
    /Uint8Array or Uint16Array/i,
  );
  assert.deepEqual(sourceField.categories, ['alpha', 'beta']);
  assert.deepEqual(sourceField.codes, [0, 1]);
  assert.equal(sourceField._isDeleted, false);
});

test('category transforms preserve primitive identity and reject corrupt codes', () => {
  const deleted = buildDeleteToUnassignedTransform(
    [0, false, 'unassigned'],
    0,
    { unassignedLabel: 'unassigned' },
  );
  assert.deepEqual(deleted.categories, [false, 'unassigned']);
  assert.deepEqual(Array.from(deleted.mapping), [1, 0, 1]);
  assert.deepEqual(
    Array.from(applyCategoryIndexMapping(
      Uint8Array.from([0, 1, 2, 255]),
      deleted.mapping,
      deleted.categories.length,
    )),
    [1, 0, 1, 255],
  );

  const merged = buildMergeCategoriesTransform(
    [0, false, '0'],
    1,
    2,
  );
  assert.deepEqual(merged.categories, [0, '0']);
  assert.deepEqual(Array.from(merged.mapping), [0, 1, 1]);
  assert.throws(
    () => applyCategoryIndexMapping(
      Uint8Array.from([0, 3]),
      merged.mapping,
      merged.categories.length,
    ),
    /outside the old category inventory/i,
  );
  assert.throws(
    () => buildDeleteToUnassignedTransform(
      ['A'],
      0,
      { unassignedLabel: ' Unassigned ' },
    ),
    /nonempty trimmed unassignedLabel/i,
  );
});

test('highlight-page fields require exact labels and serialize the valid current schema', () => {
  const registry = new UserDefinedFieldsRegistry();
  const state = {
    pointCount: 4,
    highlightPages: [
      {
        id: 'activated',
        highlightedGroups: [{
          enabled: true,
          cellIndices: Uint32Array.from([0, 2]),
        }],
      },
      {
        id: 'resting',
        highlightedGroups: [{
          enabled: true,
          cellIndices: [1],
        }],
      },
    ],
    dimensionManager: {
      positionCache: new Map([
        [2, Float32Array.from([
          0, 0,
          1, 0,
          0, 1,
          1, 1,
        ])],
      ]),
      getAvailableDimensions() {
        return [2];
      },
    },
  };

  assert.throws(
    () => registry.createFromPages({
      key: 'activation',
      pages: [{ pageId: 'activated' }],
      uncoveredLabel: 'Uncovered',
      overlapStrategy: OverlapStrategy.FIRST,
      overlapLabel: '',
      intersectionLabels: {},
    }, state),
    /Page 0 must contain exactly pageId and label/i,
  );
  assert.equal(registry.getAllFields().length, 0);

  const created = registry.createFromPages({
    key: 'activation',
    pages: [
      { pageId: 'activated', label: 'Activated' },
      { pageId: 'resting', label: 'Resting' },
    ],
    uncoveredLabel: 'Uncovered',
    overlapStrategy: OverlapStrategy.FIRST,
    overlapLabel: '',
    intersectionLabels: {},
  }, state);

  assert.deepEqual(
    created.field.categories,
    ['Activated', 'Resting', 'Uncovered'],
  );
  assert.deepEqual(Array.from(created.field.codes), [0, 1, 0, 2]);
  assert.equal(created.conflicts, 0);
  assert.equal(created.uncoveredCount, 1);

  const [metadata] = registry.toSessionMeta();
  assert.equal(metadata.id, created.id);
  assert.equal(metadata.source, FieldSource.OBS);
  assert.equal(metadata.kind, 'category');
  assert.equal(metadata.codesType, 'Uint8Array');
  assert.equal(metadata.codesLength, 4);
  assert.deepEqual(metadata.sourcePages, [
    { pageId: 'activated', label: 'Activated' },
    { pageId: 'resting', label: 'Resting' },
  ]);
});

test('intersection fields require every exact user label and never invent or rename categories', () => {
  const registry = new UserDefinedFieldsRegistry();
  const state = {
    pointCount: 4,
    highlightPages: [
      {
        id: 'a',
        highlightedGroups: [{
          enabled: true,
          cellIndices: Uint32Array.from([0, 2]),
        }],
      },
      {
        id: 'b',
        highlightedGroups: [{
          enabled: true,
          cellIndices: Uint32Array.from([1, 2]),
        }],
      },
    ],
    dimensionManager: {
      positionCache: new Map([
        [2, Float32Array.from([
          0, 0,
          1, 0,
          0, 1,
          1, 1,
        ])],
      ]),
      getAvailableDimensions() {
        return [2];
      },
    },
  };
  const options = {
    key: 'intersection',
    pages: [
      { pageId: 'a', label: 'A' },
      { pageId: 'b', label: 'B' },
    ],
    uncoveredLabel: 'Uncovered',
    overlapStrategy: OverlapStrategy.INTERSECTIONS,
    overlapLabel: '',
    intersectionLabels: {},
  };

  assert.throws(
    () => registry.createFromPages(options, state),
    /identify every current overlap mask exactly once/i,
  );
  assert.equal(registry.getAllFields().length, 0);

  const created = registry.createFromPages({
    ...options,
    intersectionLabels: { 3: 'Both' },
  }, state);
  assert.deepEqual(
    created.field.categories,
    ['A', 'B', 'Both', 'Uncovered'],
  );
  assert.deepEqual(Array.from(created.field.codes), [0, 1, 2, 3]);
  assert.equal(created.conflicts, 1);
  assert.equal(created.uncoveredCount, 1);

  const duplicateRegistry = new UserDefinedFieldsRegistry();
  assert.throws(
    () => duplicateRegistry.createFromPages({
      ...options,
      intersectionLabels: { 3: 'A' },
    }, state),
    /duplicates a category label/i,
  );
  assert.equal(duplicateRegistry.getAllFields().length, 0);
});

test('highlight-page creation rejects duplicate visible field names before registry mutation', () => {
  let registryCalls = 0;
  const state = Object.assign(
    Object.create(FieldCategoryOpsMethods.prototype),
    {
      obsData: {
        fields: [{ key: 'existing', kind: 'category' }],
      },
      _userDefinedFields: {
        createFromPages() {
          registryCalls += 1;
          throw new Error('registry must not be reached');
        },
      },
    },
  );
  assert.throws(
    () => state.createCategoricalFromPages({
      key: 'existing',
      pages: [{ pageId: 'a', label: 'A' }],
      uncoveredLabel: '',
      overlapStrategy: OverlapStrategy.FIRST,
      overlapLabel: '',
      intersectionLabels: {},
    }),
    /visible observation field.*already exists/i,
  );
  assert.equal(registryCalls, 0);
  assert.equal(state.obsData.fields.length, 1);
});

test('user-defined categorical state preserves exact primitive category identity', () => {
  const registry = new UserDefinedFieldsRegistry();
  const state = {
    pointCount: 3,
    dimensionManager: {
      positionCache: new Map([
        [2, Float32Array.from([
          0, 0,
          1, 0,
          0, 1,
        ])],
      ]),
      getAvailableDimensions() {
        return [2];
      },
    },
  };
  const categories = [0, false, '0'];
  const created = registry.createFromCategoricalCodes({
    key: 'primitive_groups',
    categories,
    codes: Uint8Array.from([0, 1, 2]),
    source: FieldSource.OBS,
  }, state);

  assert.deepEqual(created.field.categories, categories);
  assert.deepEqual(
    created.field.centroidsByDim['2'].map(centroid => centroid.category),
    categories,
  );
  const metadata = registry.toSessionMeta();
  assert.deepEqual(metadata[0].categories, categories);

  const restored = new UserDefinedFieldsRegistry();
  restored.fromSessionMeta(metadata);
  assert.deepEqual(restored.getField(created.id).categories, categories);
  assert.throws(
    () => registry.createFromCategoricalCodes({
      key: 'invalid_groups',
      categories: [Number.NaN],
      codes: Uint8Array.from([0, 0, 0]),
      source: FieldSource.OBS,
    }, state),
    /finite/i,
  );
  assert.equal(registry.getAllFields().length, 1);
});

test('categorical upsert replaces stale derived metadata as one exact update', () => {
  const registry = new UserDefinedFieldsRegistry();
  const state = Object.assign(
    Object.create(FieldOverlayPublicMethods.prototype),
    {
      pointCount: 2,
      dimensionManager: {
        positionCache: new Map([
          [2, Float32Array.from([
            0, 0,
            1, 1,
          ])],
        ]),
        getAvailableDimensions() {
          return [2];
        },
      },
      _userDefinedFields: registry,
      ensureCategoryMetadata:
        DataStateColorMethods.prototype.ensureCategoryMetadata,
      _syncActiveContext() {},
      _notifyFieldChange() {},
    },
  );
  const created = registry.createFromCategoricalCodes({
    key: 'consensus',
    categories: ['Old'],
    codes: Uint8Array.from([0, 0]),
    source: FieldSource.OBS,
    meta: {
      _sourceField: {
        kind: 'community-annotation',
        sourceKey: 'cell_type',
        sourceIndex: 0,
      },
      _operation: {
        type: 'community-consensus',
        revision: 1,
      },
    },
  }, state);
  state.obsData = { fields: [created.field] };
  state.ensureCategoryMetadata(created.field);
  created.field._categoryColors[0] = [0.2, 0.3, 0.4];
  created.field._categoryVisible[0] = false;
  created.field._normalizedDims.add('2');
  created.field._categoryCounts = {
    visible: [2],
    total: [2],
    visibleTotal: 2,
  };

  const result = state.upsertUserDefinedCategoricalField({
    key: 'consensus',
    categories: ['Old', 'New'],
    codes: Uint8Array.from([0, 1]),
    meta: {
      _sourceField: {
        kind: 'community-annotation',
        sourceKey: 'cell_type',
        sourceIndex: 0,
      },
      _operation: {
        type: 'community-consensus',
        revision: 2,
      },
    },
  });

  assert.deepEqual(result, {
    fieldIndex: 0,
    key: 'consensus',
    updatedInPlace: true,
  });
  assert.deepEqual(created.field.categories, ['Old', 'New']);
  assert.deepEqual(Array.from(created.field.codes), [0, 1]);
  assert.deepEqual(created.field._categoryColors[0], [0.2, 0.3, 0.4]);
  assert.equal(created.field._categoryVisible[0], false);
  assert.equal(created.field._categoryVisible[1], true);
  assert.equal(created.field._categoryColors.length, 2);
  assert.deepEqual([...created.field._normalizedDims], []);
  assert.equal(created.field._categoryCounts, undefined);
  assert.equal(created.field._operation.revision, 2);
  assert.strictEqual(registry.getField(created.id), created.field);

  const categoriesBeforeFailure = [...created.field.categories];
  const codesBeforeFailure = created.field.codes;
  assert.throws(
    () => state.upsertUserDefinedCategoricalField({
      key: 'consensus',
      categories: ['Old', 'New'],
      codes: Uint8Array.from([0, 2]),
    }),
    /outside the category inventory/i,
  );
  assert.deepEqual(created.field.categories, categoriesBeforeFailure);
  assert.strictEqual(created.field.codes, codesBeforeFailure);
  assert.throws(
    () => registry.updateField(created.id, { unsupported: true }),
    /unsupported user-defined field update/i,
  );
});

test('community merge traversal is deterministic and rejects duplicate or cyclic edges', () => {
  const mergeA = {
    fromSuggestionId: 'suggestion-a',
    intoSuggestionId: 'suggestion-b',
  };
  const mergeB = {
    fromSuggestionId: 'suggestion-b',
    intoSuggestionId: 'suggestion-target',
  };
  const unrelated = {
    fromSuggestionId: 'unrelated-a',
    intoSuggestionId: 'unrelated-b',
  };
  const traversal = buildMergeTraversal({
    targetSuggestionId: 'suggestion-target',
    merges: [mergeB, unrelated, mergeA],
  });
  assert.deepEqual(
    traversal.steps.map(step => [
      step.fromSuggestionId,
      step.intoSuggestionId,
      step.merge,
    ]),
    [
      ['suggestion-a', 'suggestion-b', mergeA],
      ['suggestion-b', 'suggestion-target', mergeB],
    ],
  );

  assert.throws(
    () => buildMergeTraversal({
      targetSuggestionId: 'suggestion-target',
      merges: [mergeA, { ...mergeA }],
    }),
    /duplicate source/i,
  );
  assert.throws(
    () => buildMergeTraversal({
      targetSuggestionId: 'suggestion-target',
      merges: [
        {
          fromSuggestionId: 'cycle-a',
          intoSuggestionId: 'cycle-b',
        },
        {
          fromSuggestionId: 'cycle-b',
          intoSuggestionId: 'cycle-a',
        },
      ],
    }),
    /cycle/i,
  );
});
