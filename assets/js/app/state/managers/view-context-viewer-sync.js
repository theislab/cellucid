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
import { adoptScientificFieldDescriptors } from './field/descriptor-ownership.js';
import {
  createNeutralColors,
  createShownCellVisibilityMask,
  markSnapshotPublishedColors,
  recordAlphaBytesMirror,
  transparencyArrayWrites,
  writableTransparency,
} from './per-cell-array-ownership.js';
import { recordUnfilteredVisibility } from './filter-manager.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { createCellIdentity } from '../../../data/cell-identity.js';
import { DEFAULT_CELL_PRIORITY, requireCellPriority } from '../../../data/cell-priority.js';

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

/**
 * Record on `state` the transparency array (and its write count) whose bytes
 * the live viewer now holds, or forget it (`null`).
 */
function recordLiveViewerTransparency(state, transparency) {
  state._liveViewerTransparency = transparency === null
    ? null
    : { transparency, writes: transparencyArrayWrites(transparency) };
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
    if (this._isLiveView()) {
      const held = this._liveViewerTransparency;
      if (
        held !== null
        && held !== undefined
        && held.transparency === this.categoryTransparency
        && held.writes === transparencyArrayWrites(this.categoryTransparency)
      ) {
        // The live viewer already holds exactly these bytes: they were
        // published from this array and it has not been written since.
        return;
      }
    }
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
        recordLiveViewerTransparency(this, null);
        this.viewer.updateTransparency(this.categoryTransparency);
        recordLiveViewerTransparency(this, this.categoryTransparency);
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
    // The active field indexes the inventories this replaces. It is retired
    // first, before an inventory, the renderer or any listener sees the new
    // dataset: an index kept any longer points into the new dataset's fields
    // or genes (outside them, or at another field), and every synchronous
    // notification below -- the renderer's new points, the centroid reset,
    // the view contexts -- would read it there.
    this.activeFieldIndex = -1;
    this.activeVarFieldIndex = -1;
    this.activeFieldSource = null;
    this._activeCategoryCounts = null;
    this._datasetGeneration = (this._datasetGeneration ?? 0) + 1;
    // The replaced dataset's outlier jobs stop reading its latent space, and
    // what was kept from its cells goes: the visibility count's arrays (its
    // transparency and outlier quantiles) and the page-count scratch.
    this.retireOutlierJobs();
    this._filteredCountMemo = null;
    this._highlightMembershipScratch = null;
    // A new dataset starts with the gene list it was published with.
    this._varAxisGeneration = 0;
    // Dataset swap: ensure GPU overlay resources referencing the previous dataset
    // are released before we upload new buffers.
    this.viewer.resetVectorFieldOverlay?.();

    const obsFields = obs?.fields || [];
    this._obsFieldDescriptors = adoptScientificFieldDescriptors(obsFields);
    const normalizedFields = obsFields.map((field) => {
      return {
        ...field,
        categories: Array.isArray(field?.categories)
          ? [...field.categories]
          : field?.categories,
        loaded: Boolean(field?.values || field?.codes),
        _loadingPromise: null,
        _loadingSignal: null,
        // A categorical field's centroids are computed in the browser, once
        // per layout, from its codes and the layout's positions, and cached
        // here. The cache and the record of which layouts are done have
        // exactly the field's lifetime: every view context clones this field
        // shallowly, so this one Map and this one Set are shared by all of
        // them. A per-clone `null` let a view kept before the field's first
        // colouring normalize the shared arrays a second time.
        ...(field?.kind === 'category' ? { centroidsByLayout: new Map() } : {}),
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
    // Scores name cells of the reading they were computed on.
    this._derivedResults?.clearScores();
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
        `Scene positions must be a Float32Array with exactly ${formatCountOf(positionsDimension, 'value')} per cell.`
      );
    }
    this.positionsArray = positions;
    this.positionsDimension = positionsDimension;

    this.pointCount = positions.length / positionsDimension;
    // Every cell of the dataset is open; a subsample's identity replaces
    // this one (`setCellIdentity`) before anything names a cell.
    this.cellIdentity = createCellIdentity({ nObs: this.pointCount });
    this.cellPriority = DEFAULT_CELL_PRIORITY;

    this.colorsArray = createNeutralColors(this.pointCount);
    this.categoryTransparency = new Uint8Array(this.pointCount).fill(1);
    this.cellVisibilityMask = createShownCellVisibilityMask(this.pointCount);
    // Every cell shown, with opaque alpha bytes: the first visibility pass
    // (no filter yet) adopts this generation instead of writing it again.
    recordUnfilteredVisibility(this.categoryTransparency, this.cellVisibilityMask);
    recordAlphaBytesMirror(this.colorsArray, this.categoryTransparency);
    this.filteredCount = { shown: this.pointCount, total: this.pointCount };

    recordLiveViewerTransparency(this, null);
    this.viewer.setData({
      positions,
      colors: this.colorsArray,
      transparency: this.categoryTransparency,
      dimensionLevel: positionsDimension,
      layoutKey
    });
    recordLiveViewerTransparency(this, this.categoryTransparency);

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
    // No cell is highlighted: the published list is exactly empty.
    this._highlightedCellIndices = new Uint32Array(0);
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
    const cellVisibilityMask = createShownCellVisibilityMask(exact.pointCount);
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

    // The live viewer's transparency is about to be replaced: what it held
    // is no longer known, so the next publication is sent.
    recordLiveViewerTransparency(this, null);
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
    this.retireOutlierJobs();
    this._filteredCountMemo = null;
    this._highlightMembershipScratch = null;
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
    this._derivedResults.clear();
    getFieldRegistry().invalidate();

    this.positionsArray = exact.positions;
    this.positionsDimension = exact.dimensionLevel;
    this.pointCount = exact.pointCount;
    this.cellIdentity = createCellIdentity({ nObs: this.pointCount });
    this.cellPriority = DEFAULT_CELL_PRIORITY;
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
    this._highlightedCellIndices = new Uint32Array(0);
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

  /**
   * Publish which cells of the dataset are open (`data/cell-identity.js`):
   * a subsample's identity, its `n` the cells this scene holds. Everything
   * that names a cell outside the app (the viewer channel, exports) names it
   * by original position through this identity.
   *
   * @param {import('../../../data/cell-identity.js').CellIdentity} identity
   */
  setCellIdentity(identity) {
    if (
      identity === null
      || typeof identity !== 'object'
      || typeof identity.toOriginal !== 'function'
      || identity.n !== this.pointCount
    ) {
      throw new TypeError(`A cell identity must name the ${this.pointCount} open cells`);
    }
    this.cellIdentity = identity;
  },

  /**
   * Publish the priority of the open cells (`data/cell-priority.js`): the
   * order levels of detail draw them in and progressive analyses take their
   * first pass from. A scene starts with every cell ranked under the default
   * seed; its source says otherwise right after it is published.
   *
   * @param {Readonly<{seed: number|null, originals: Uint32Array|null}>} priority
   */
  setCellPriority(priority) {
    const exact = requireCellPriority(priority, this.pointCount);
    this.viewer.setCellPriority(exact);
    this.cellPriority = exact;
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
