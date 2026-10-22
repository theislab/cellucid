/**
 * @fileoverview Viewer synchronization + dataset init helpers for DataState views.
 *
 * Split out of `view-manager.js` to keep file sizes manageable while preserving
 * performance-critical comments and behavior.
 *
 * @module state/managers/view-context-viewer-sync
 */

import { getFieldRegistry } from '../../utils/field-registry.js';
import { getPageColor } from '../../utils/page-colors.js';
import { fillNeutralGray } from '../core/constants.js';
import { adoptScientificFieldDescriptors } from './field/descriptor-ownership.js';
import {
  markSnapshotPublishedColors,
  writableTransparency,
} from './per-cell-array-ownership.js';

/**
 * Own a manifest field's centroids by layout: `centroidsByEmbedding` is keyed
 * by embedding id, which is the layout key of that embedding. An id the
 * dimension manager has not registered has no reachable centroids. The arrays
 * are copied so lazy in-place normalization owns them; malformed shapes pass
 * through unchanged for buildCentroidsForField to reject.
 */
function ownCentroidsByLayout(centroidsByEmbedding, dimensionManager) {
  if (
    centroidsByEmbedding === null
    || typeof centroidsByEmbedding !== 'object'
    || Array.isArray(centroidsByEmbedding)
  ) {
    return centroidsByEmbedding;
  }
  const owned = new Map();
  for (const [layoutKey, centroids] of Object.entries(centroidsByEmbedding)) {
    if (!dimensionManager.hasLayout(layoutKey)) continue;
    owned.set(layoutKey, Array.isArray(centroids)
      ? centroids.map((centroid) => (
          centroid !== null
          && typeof centroid === 'object'
          && Array.isArray(centroid.position)
            ? { ...centroid, position: [...centroid.position] }
            : centroid
        ))
      : centroids);
  }
  return owned;
}

const SYNTHETIC_SCENE_KEYS = Object.freeze([
  'colors',
  'dimensionLevel',
  'dimensionManager',
  'positions'
]);

function requireSyntheticScene(scene) {
  if (
    scene === null ||
    typeof scene !== 'object' ||
    Array.isArray(scene)
  ) {
    throw new TypeError(
      'Synthetic scene publication requires one exact object.'
    );
  }
  const keys = Object.keys(scene);
  if (
    keys.length !== SYNTHETIC_SCENE_KEYS.length ||
    keys.some(key => !SYNTHETIC_SCENE_KEYS.includes(key))
  ) {
    throw new TypeError(
      'Synthetic scene publication requires exactly colors, ' +
      'dimensionLevel, dimensionManager, and positions.'
    );
  }
  if (
    !Number.isInteger(scene.dimensionLevel) ||
    scene.dimensionLevel < 1 ||
    scene.dimensionLevel > 3
  ) {
    throw new RangeError(
      'Synthetic scene dimensionLevel must be exactly 1, 2, or 3.'
    );
  }
  if (
    !(scene.positions instanceof Float32Array) ||
    scene.positions.length === 0 ||
    scene.positions.length % scene.dimensionLevel !== 0 ||
    scene.positions.byteLength !==
      scene.positions.length * Float32Array.BYTES_PER_ELEMENT
  ) {
    throw new TypeError(
      'Synthetic scene positions must be a non-empty exact Float32 array ' +
      'with dimensionLevel values per point.'
    );
  }
  for (let index = 0; index < scene.positions.length; index += 1) {
    if (!Number.isFinite(scene.positions[index])) {
      throw new RangeError(
        `Synthetic scene position ${index} must be finite.`
      );
    }
  }
  const pointCount = scene.positions.length / scene.dimensionLevel;
  if (
    !(scene.colors instanceof Uint8Array) ||
    scene.colors.length !== pointCount * 4 ||
    scene.colors.byteLength !==
      scene.colors.length * Uint8Array.BYTES_PER_ELEMENT
  ) {
    throw new TypeError(
      'Synthetic scene colors must be an exact dataset-length Uint8 RGBA array.'
    );
  }

  const manager = scene.dimensionManager;
  for (const methodName of [
    'clearCache',
    'getLayout',
    'getPositions',
    'getViewLayout',
    'isEnabled',
    'setViewLayout'
  ]) {
    if (
      manager === null ||
      typeof manager !== 'object' ||
      typeof manager[methodName] !== 'function'
    ) {
      throw new TypeError(
        `Synthetic dimension manager must provide ${methodName}().`
      );
    }
  }
  // The scene may enable several representations; the live view shows one,
  // and the published positions are that one's.
  const liveLayoutKey = manager.getViewLayout('live');
  if (
    manager.isEnabled(liveLayoutKey) !== true ||
    manager.getLayout(liveLayoutKey).dimension !== scene.dimensionLevel
  ) {
    throw new Error(
      'Synthetic dimension manager must show an enabled representation of the published dimension.'
    );
  }

  return Object.freeze({
    colors: scene.colors,
    dimensionLevel: scene.dimensionLevel,
    dimensionManager: manager,
    layoutKey: liveLayoutKey,
    pointCount,
    positions: scene.positions
  });
}

function requireSyntheticViewer(viewer) {
  for (const methodName of [
    'clearSnapshotViews',
    'getViewLayoutKey',
    'resetVectorFieldOverlay',
    'setCentroidLabels',
    'setCentroids',
    'setData',
    'updateHighlight'
  ]) {
    if (
      viewer === null ||
      typeof viewer !== 'object' ||
      typeof viewer[methodName] !== 'function'
    ) {
      throw new TypeError(
        `Synthetic scene viewer must provide ${methodName}().`
      );
    }
  }
  return viewer;
}

export const viewContextViewerSyncMethods = {
  _pushColorsToViewer() {
    if (this._isLiveView()) {
      this.viewer.updateColors(this.colorsArray);
    } else if (typeof this.viewer.updateSnapshotAttributes === 'function') {
      // The viewer keeps a snapshot's colors by reference from here on.
      markSnapshotPublishedColors(this.colorsArray);
      this.viewer.updateSnapshotAttributes(this.activeViewId, { colors: this.colorsArray });
    }
  },

  _pushTransparencyToViewer() {
    // IMPORTANT: Do NOT call _pushColorsToViewer() here!
    // The alpha texture fast path in hp-renderer handles transparency updates efficiently
    // without requiring full buffer rebuilds. Calling updateColors() here would set
    // full-detail and dimension-specific LOD color dirtiness, negating the
    // alpha texture optimization
    // and causing stuttering on large datasets during filter changes.
    // The updateTransparency/updateAlphas path handles both:
    // - Alpha texture case: just updates texture (fast, ~16x faster than buffer rebuild)
    // - Alpha-buffer case: uses an alpha-only dirty flag for efficient partial updates
    try {
      if (this._isLiveView()) {
        this.viewer.updateTransparency(this.categoryTransparency);
      } else if (typeof this.viewer.updateSnapshotAttributes === 'function') {
        this.viewer.updateSnapshotAttributes(this.activeViewId, { transparency: this.categoryTransparency });
      }
    } catch (publicationError) {
      const restorationFailures = [];
      try {
        const accepted = this.viewer.getViewTransparency(
          this.activeViewId
        );
        if (
          !(accepted instanceof Uint8Array) ||
          !(this.categoryTransparency instanceof Uint8Array) ||
          accepted.length !== this.categoryTransparency.length
        ) {
          throw new TypeError(
            'Visibility rollback requires the exact accepted view transparency.'
          );
        }
        writableTransparency(this).set(accepted);
        this._syncColorsAlpha();
        this._updateActiveCategoryCounts();
      } catch (restorationError) {
        restorationFailures.push(restorationError);
      }
      if (restorationFailures.length > 0) {
        throw new AggregateError(
          [publicationError, ...restorationFailures],
          'Visibility publication failed with incomplete application-state restoration.'
        );
      }
      throw publicationError;
    }
  },

  _pushCentroidsToViewer() {
    if (this._isLiveView()) {
      this.viewer.setCentroids({
        positions: this.centroidPositions || new Float32Array(),
        colors: this.centroidColors || new Uint8Array()
      });
      this.viewer.setCentroidLabels(this.centroidLabels, this.activeViewId);
    } else if (typeof this.viewer.updateSnapshotAttributes === 'function') {
      this.viewer.updateSnapshotAttributes(this.activeViewId, {
        centroidPositions: this.centroidPositions || new Float32Array(),
        centroidColors: this.centroidColors || new Uint8Array()
      });
      if (typeof this.viewer.setCentroidLabels === 'function') {
        this.viewer.setCentroidLabels(this.centroidLabels, this.activeViewId);
      }
    }
  },

  _getCentroidsForActiveLayout(field) {
    if (!field || !(field.centroidsByLayout instanceof Map)) return [];
    const layoutKey = this.getViewLayoutKey(this.activeViewId);
    return field.centroidsByLayout.get(layoutKey) || [];
  },

  _rebuildLabelLayerFromCentroids() {
    if (!this.labelLayer || !this.viewer) return;
    const viewKey = String(this.activeViewId || 'live');
    this._removeLabelsForView(viewKey);
    this.centroidLabels = [];
    const field = this.getActiveField ? this.getActiveField() : null;
    const centroids = this._getCentroidsForActiveLayout(field);
    if (!field || field.kind !== 'category' || !this.centroidPositions || centroids.length === 0) {
      this.viewer.setCentroidLabels([], viewKey);
      return;
    }
    const max = Math.min(centroids.length, this.centroidPositions.length / 3);
    for (let i = 0; i < max; i++) {
      const pos = [
        this.centroidPositions[3 * i],
        this.centroidPositions[3 * i + 1],
        this.centroidPositions[3 * i + 2]
      ];
      const el = document.createElement('div');
      el.className = 'centroid-label';
      el.dataset.viewId = viewKey;
      el.textContent = String(centroids[i].category);
      this.labelLayer.appendChild(el);
      this.centroidLabels.push({ el, position: pos, alpha: 1.0 });
    }
    const counts = field._categoryCounts || this._activeCategoryCounts;
    if (counts) {
      const changed = this._applyCategoryCountsToCentroids(field, counts);
      if (changed) this._pushCentroidsToViewer();
    }
    this.viewer.setCentroidLabels(this.centroidLabels, viewKey);
  },

  initScene(positions, obs) {
    this._datasetGeneration = (this._datasetGeneration ?? 0) + 1;
    // A new dataset starts with the gene list it was published with.
    this._varAxisGeneration = 0;
    // Dataset swap: ensure GPU overlay resources referencing the previous dataset
    // are released before we upload new buffers.
    this.viewer.resetVectorFieldOverlay?.();

    const manifestFields = obs?.fields || [];
    this._obsFieldDescriptors = adoptScientificFieldDescriptors(manifestFields);
    const normalizedFields = manifestFields.map((field) => {
      const hasCentroids = field !== null && typeof field === 'object'
        && Object.hasOwn(field, 'centroidsByEmbedding');
      const rest = { ...field };
      delete rest.centroidsByEmbedding;
      return {
        ...rest,
        categories: Array.isArray(field?.categories)
          ? [...field.categories]
          : field?.categories,
        loaded: Boolean(field?.values || field?.codes),
        _loadingPromise: null,
        _loadingSignal: null,
        // Centroids are normalized lazily and in place, once per layout.
        // The record of which layouts are done has to have exactly the
        // lifetime of the arrays it describes: every view context clones this
        // field shallowly, so the copied centroid arrays and this one Set are
        // shared by all of them. A per-clone `null` let a view kept before the
        // field's first colouring normalize the shared arrays a second time.
        // The arrays themselves are copied so normalization never rewrites the
        // dataset generation's manifest.
        ...(hasCentroids
          ? {
              centroidsByLayout: ownCentroidsByLayout(
                field.centroidsByEmbedding,
                this.dimensionManager
              )
            }
          : {}),
        _normalizedLayouts: new Set()
      };
    });
    this.obsData = { ...obs, fields: normalizedFields };
    this._fieldDataCache.clear();
    this._varFieldDataCache.clear();
    this._fieldUseOrder = new Map();
    this._fieldUseClock = 0;

    this._renameRegistry.clear();
    this._deleteRegistry.clear();
    this._userDefinedFields.clear();
    getFieldRegistry().invalidate();

    // An empty scene (no dataset) shows no layout; its stride is moot.
    const layoutKey = positions.length === 0
      ? null
      : this.getViewLayoutKey('live');
    const positionsDimension = layoutKey === null
      ? 3
      : this.dimensionManager.getLayout(layoutKey).dimension;
    if (
      !(positions instanceof Float32Array) ||
      positions.length % positionsDimension !== 0
    ) {
      throw new TypeError(
        `Scene positions must be a Float32Array with exactly ${positionsDimension} values per cell.`
      );
    }
    this.positionsArray = positions;
    this.positionsDimension = positionsDimension;

    this.pointCount = positions.length / positionsDimension;

    this.colorsArray = fillNeutralGray(new Uint8Array(this.pointCount * 4));
    this.categoryTransparency = new Uint8Array(this.pointCount).fill(1);
    this.cellVisibilityMask = new Uint8Array(this.pointCount).fill(1);
    this.filteredCount = { shown: this.pointCount, total: this.pointCount };

    this.viewer.setData({
      positions,
      colors: this.colorsArray,
      transparency: this.categoryTransparency,
      dimensionLevel: positionsDimension,
      layoutKey
    });

    this.clearCentroids();
    this.viewer.setCentroids({
      positions: new Float32Array(),
      colors: new Uint8Array()
    });
    this.viewer.setCentroidLabels([], this.activeViewId);

    this.highlightPages = [{
      id: 'page_1',
      name: 'Page 1',
      color: getPageColor(0),
      highlightedGroups: []
    }];
    this.activePageId = 'page_1';
    this._highlightPageIdCounter = 1;
    this.highlightArray = new Uint8Array(this.pointCount);
    this._highlightedCellIndices = [];
    this._highlightIdCounter = 0;
    this._cachedHighlightCount = null;
    this._cachedTotalHighlightCount = null;
    this._cachedHighlightLodMembership = null;

    // Publish the new dataset with no active field/filter owner before any
    // synchronous state notification escapes. A prior categorical selection
    // can have the same field index in the replacement manifest while its
    // codes are still intentionally lazy; exposing that stale index lets UI
    // listeners initialize filter metadata against the wrong generation.
    this.activeFieldIndex = -1;
    this.activeVarFieldIndex = -1;
    this.activeFieldSource = null;
    this._activeCategoryCounts = null;
    this._batchMode = false;
    this._batchDepth = 0;
    this._batchDirty = {
      visibility: false,
      colors: false,
      affectedFields: new Set()
    };

    this._resetViewContexts();
    this._notifyHighlightPageChange();
  },

  /**
   * Publish an in-memory benchmark as a complete DataState generation.
   *
   * Validation and all next-generation buffers are completed before the
   * renderer or DataState is touched. The renderer is restored from the
   * current DataState payload if its new-data publication rejects.
   *
   * @param {{
   *   colors: Uint8Array,
   *   dimensionLevel: number,
   *   dimensionManager: object,
   *   positions: Float32Array
   * }} scene
   */
  initSyntheticScene(scene) {
    const exact = requireSyntheticScene(scene);
    const viewer = requireSyntheticViewer(this.viewer);
    const transparency = new Uint8Array(exact.pointCount).fill(1);
    const cellVisibilityMask = new Uint8Array(exact.pointCount).fill(1);
    const highlights = new Uint8Array(exact.pointCount);
    const emptyCentroidPositions = new Float32Array(0);
    const emptyCentroidColors = new Uint8Array(0);

    const previousRendererPayload = Object.freeze({
      positions: this.positionsArray,
      colors: this.colorsArray,
      transparency: this.categoryTransparency,
      dimensionLevel: this.positionsDimension,
      layoutKey: viewer.getViewLayoutKey('live')
    });
    const previousCentroidPayload = Object.freeze({
      positions: this.centroidPositions instanceof Float32Array
        ? this.centroidPositions
        : new Float32Array(0),
      colors: this.centroidColors instanceof Uint8Array
        ? this.centroidColors
        : new Uint8Array(0)
    });
    const previousCentroidLabels = Array.isArray(this.centroidLabels)
      ? this.centroidLabels
      : [];
    const previousViewId = this.activeViewId;

    try {
      viewer.setData({
        positions: exact.positions,
        colors: exact.colors,
        transparency,
        dimensionLevel: exact.dimensionLevel,
        layoutKey: exact.layoutKey
      });
      viewer.setCentroids({
        positions: emptyCentroidPositions,
        colors: emptyCentroidColors
      });
      viewer.setCentroidLabels([], 'live');
      viewer.updateHighlight(highlights, []);
    } catch (publicationError) {
      try {
        viewer.setData(previousRendererPayload);
        viewer.setCentroids(previousCentroidPayload);
        viewer.setCentroidLabels(
          previousCentroidLabels,
          previousViewId
        );
        viewer.updateHighlight(this.highlightArray);
      } catch (restorationError) {
        throw new AggregateError(
          [publicationError, restorationError],
          'Synthetic scene publication and renderer restoration both failed.'
        );
      }
      throw publicationError;
    }

    this._datasetGeneration = (this._datasetGeneration ?? 0) + 1;
    viewer.clearSnapshotViews();
    viewer.resetVectorFieldOverlay();

    this.fieldLoader = null;
    this.varFieldLoader = null;
    this.dimensionManager = exact.dimensionManager;
    this.vectorFieldManager = null;
    this.publishDatasetMapping({ mapping: null, candidates: null, origin: null });
    this._obsFieldDescriptors = Object.freeze([]);
    this._varFieldDescriptors = Object.freeze([]);
    this.obsData = { fields: [] };
    this.varData = null;
    this._fieldDataCache.clear();
    this._varFieldDataCache.clear();
    this._fieldUseOrder = new Map();
    this._fieldUseClock = 0;
    this._renameRegistry.clear();
    this._deleteRegistry.clear();
    this._userDefinedFields.clear();
    getFieldRegistry().invalidate();

    this.positionsArray = exact.positions;
    this.positionsDimension = exact.dimensionLevel;
    this.pointCount = exact.pointCount;
    this.colorsArray = exact.colors;
    this.categoryTransparency = transparency;
    this.cellVisibilityMask = cellVisibilityMask;
    this.filteredCount = {
      shown: exact.pointCount,
      total: exact.pointCount
    };

    this.activeFieldIndex = -1;
    this.activeVarFieldIndex = -1;
    this.activeFieldSource = null;
    this._activeCategoryCounts = null;
    this.centroidCount = 0;
    this.centroidPositions = emptyCentroidPositions;
    this.centroidColors = emptyCentroidColors;
    this.centroidOutliers = new Float32Array(0);
    this.centroidLabels = [];

    this.highlightPages = [{
      id: 'page_1',
      name: 'Page 1',
      color: getPageColor(0),
      highlightedGroups: []
    }];
    this.activePageId = 'page_1';
    this._highlightPageIdCounter = 1;
    this.highlightArray = highlights;
    this._highlightedCellIndices = [];
    this._highlightIdCounter = 0;
    this._cachedHighlightCount = null;
    this._cachedTotalHighlightCount = null;
    this._cachedHighlightLodMembership = null;

    this._batchMode = false;
    this._batchDepth = 0;
    this._batchDirty = {
      visibility: false,
      colors: false,
      affectedFields: new Set()
    };
    this._resetViewContexts();

    this.emit('vectorFields:changed', []);
    this._notifyRepresentationChange('live', null);
    this._notifyHighlightPageChange();
    this._notifyHighlightChange();
    this._notifyVisibilityChange();
    this.updateFilterSummary();

    return Object.freeze({
      dimensionLevel: exact.dimensionLevel,
      pointCount: exact.pointCount
    });
  },

  _notifyVisibilityChange() {
    this._invalidateHighlightCountCache(true);
    this.emit('visibility:changed');
  },

  _notifyFieldChange(source, fieldIndex, changeType, detail = null) {
    const event = { source, fieldIndex, changeType, detail };
    this.emit('field:changed', event);
  },

  getSmokeDensitySource() {
    const positions = this.positionsArray;
    const dimension = this.positionsDimension;
    const pointCount = this.pointCount;
    if (
      !(positions instanceof Float32Array)
      || (dimension !== 1 && dimension !== 2 && dimension !== 3)
      || positions.length !== pointCount * dimension
    ) {
      throw new TypeError(
        'Smoke density source requires the exact dataset Float32 positions and their dimension.'
      );
    }
    const alpha = this.categoryTransparency;
    if (
      !(alpha instanceof Uint8Array)
      || alpha.length !== pointCount
    ) {
      throw new TypeError(
        'Smoke density source requires the exact dataset visibility array.'
      );
    }
    const applyOutlierFilter = this.isOutlierFilterEnabledForActiveField();
    if (typeof applyOutlierFilter !== 'boolean') {
      throw new TypeError(
        'Smoke density source requires exact outlier-filter ownership.'
      );
    }
    const outlierQuantiles = applyOutlierFilter
      ? this.getActiveOutlierQuantiles()
      : null;
    const outlierThreshold = applyOutlierFilter
      ? this.getCurrentOutlierThreshold()
      : null;
    if (
      outlierQuantiles !== null
      && (
        !(outlierQuantiles instanceof Float32Array)
        || outlierQuantiles.length !== pointCount
      )
    ) {
      throw new TypeError(
        'Smoke density source requires exact dataset outlier quantiles.'
      );
    }
    if (
      outlierThreshold !== null
      && (
        typeof outlierThreshold !== 'number'
        || !Number.isFinite(outlierThreshold)
        || outlierThreshold < 0
        || outlierThreshold > 1
      )
    ) {
      throw new RangeError(
        'Smoke density source outlier threshold must be between 0 and 1.'
      );
    }
    const colors = this.colorsArray;
    if (
      !(colors instanceof Uint8Array)
      || colors.length !== pointCount * 4
    ) {
      throw new TypeError(
        'Smoke density source requires the exact dataset RGBA colors.'
      );
    }
    return Object.freeze({
      alpha,
      colors,
      dimension,
      outlierQuantiles,
      outlierThreshold,
      positions,
    });
  }
};
