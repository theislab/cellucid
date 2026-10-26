import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DataStateColorMethods,
} from '../assets/js/app/state/managers/color-manager.js';
import {
  DataStateFilterMethods,
} from '../assets/js/app/state/managers/filter-manager.js';
import {
  FieldLoadingMethods,
} from '../assets/js/app/state/managers/field/loading.js';
import {
  viewContextViewerSyncMethods,
} from '../assets/js/app/state/managers/view-context-viewer-sync.js';
import { writableTransparency } from '../assets/js/app/state/managers/per-cell-array-ownership.js';

function makePublicationHarness(viewId) {
  const publications = [];
  const state = {
    activeDimensionLevel: 2,
    activeFieldIndex: -1,
    activeFieldSource: null,
    activeVarFieldIndex: -1,
    activeViewId: viewId,
    categoryTransparency: new Uint8Array(2),
    colorsArray: new Uint8Array(8),
    pointCount: 2,
    viewer: {
      getViewTransparency(requestedViewId) {
        assert.equal(requestedViewId, viewId);
        return state.categoryTransparency;
      },
      updateSnapshotAttributes(requestedViewId, patch) {
        assert.equal(requestedViewId, viewId);
        assert.deepEqual(Object.keys(patch), ['transparency']);
        assert.strictEqual(
          patch.transparency,
          state.categoryTransparency,
        );
        publications.push('snapshot');
      },
      updateTransparency(transparency) {
        assert.strictEqual(
          transparency,
          state.categoryTransparency,
        );
        publications.push('live');
      },
    },
    getViewLayoutKey() {
      return '2d';
    },
    _getCentroidsForActiveLayout() {
      return [];
    },
    _isLiveView() {
      return viewId === 'live';
    },
    _pushActiveViewLabelToViewer() {},
    _pushCentroidsToViewer() {},
    _pushColorsToViewer() {},
    _pushTransparencyToViewer() {
      return viewContextViewerSyncMethods
        ._pushTransparencyToViewer
        .call(this);
    },
    _syncActiveContext() {},
    _syncColorsAlpha() {},
    _updateActiveCategoryCounts() {},
    buildCentroidsForField() {},
    clearCentroids() {},
    computeGlobalVisibility() {
      // A pass writes the visibility, then publishes it.
      writableTransparency(this);
      this._pushTransparencyToViewer();
    },
    ensureCategoryMetadata(field) {
      return DataStateColorMethods.prototype
        .ensureCategoryMetadata.call(this, field);
    },
    updateColorsCategorical(field) {
      return DataStateColorMethods.prototype
        .updateColorsCategorical.call(this, field);
    },
    _writeCategoryColors(field, writeTransparency) {
      return DataStateColorMethods.prototype
        ._writeCategoryColors.call(this, field, writeTransparency);
    },
    updateColorsContinuous(_field, options) {
      // Coloring never writes visibility: computeGlobalVisibility owns it.
      assert.equal(options, undefined);
    },
    updateFilterSummary() {},
  };
  return { publications, state };
}

for (const viewId of ['live', 'snapshot-1']) {
  test(`${viewId} categorical, continuous, variable, and clear lifecycles publish only the final alpha generation`, () => {
    const category = {
      categories: ['A', 'B'],
      centroidsByLayout: new Map([['2d', []]]),
      codes: Uint8Array.from([0, 1]),
      kind: 'category',
      key: 'cell_type',
      loaded: true,
    };
    const continuous = {
      kind: 'continuous',
      key: 'score',
      loaded: true,
      values: Float32Array.from([0, 1]),
    };
    const variable = {
      kind: 'continuous',
      key: 'GeneA',
      loaded: true,
      values: Float32Array.from([1, 2]),
    };
    const { publications, state } =
      makePublicationHarness(viewId);
    state.obsData = {
      fields: [category, continuous],
    };
    state.varData = {
      fields: [variable],
    };

    const assertOneFinalPublication = (
      operation,
      expectedRoute,
    ) => {
      publications.length = 0;
      operation();
      assert.deepEqual(
        publications,
        [expectedRoute],
      );
    };
    const expectedRoute =
      viewId === 'live' ? 'live' : 'snapshot';

    assertOneFinalPublication(
      () => FieldLoadingMethods.prototype
        .setActiveField.call(state, 0),
      expectedRoute,
    );
    assertOneFinalPublication(
      () => FieldLoadingMethods.prototype
        .setActiveField.call(state, 1),
      expectedRoute,
    );
    assertOneFinalPublication(
      () => FieldLoadingMethods.prototype
        .setActiveVarField.call(state, 0),
      expectedRoute,
    );
    assertOneFinalPublication(
      () => DataStateFilterMethods.prototype
        .clearActiveField.call(state),
      expectedRoute,
    );
    // A republication of bytes the live viewer already holds (the same
    // array, not written since) sends nothing; a snapshot is always sent.
    publications.length = 0;
    state._pushTransparencyToViewer();
    assert.deepEqual(publications, viewId === 'live' ? [] : ['snapshot']);
  });
}
