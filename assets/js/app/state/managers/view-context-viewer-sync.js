/**
 * @fileoverview Viewer synchronization + dataset init helpers for DataState views.
 *
 * Split out of `view-manager.js` to keep file sizes manageable while preserving
 * performance-critical comments and behavior.
 *
 * @module state/managers/view-context-viewer-sync
 */

import { getFieldRegistry } from '../../utils/field-registry.js';
import { NEUTRAL_GRAY_UINT8 } from '../core/constants.js';

export const viewContextViewerSyncMethods = {
  _pushColorsToViewer() {
    if (this._isLiveView()) {
      this.viewer.updateColors(this.colorsArray);
    } else if (typeof this.viewer.updateSnapshotAttributes === 'function') {
      this.viewer.updateSnapshotAttributes(this.activeViewId, { colors: this.colorsArray });
    }
  },

  _pushTransparencyToViewer() {
    // IMPORTANT: Do NOT call _pushColorsToViewer() here!
    // The alpha texture fast path in hp-renderer handles transparency updates efficiently
    // without requiring full buffer rebuilds. Calling updateColors() here would set
    // _bufferDirty and _lodBuffersDirty, negating the alpha texture optimization
    // and causing stuttering on large datasets during filter changes.
    // The updateTransparency/updateAlphas path handles both:
    // - Alpha texture case: just updates texture (fast, ~16x faster than buffer rebuild)
    // - Fallback case: uses alpha-only dirty flag for efficient partial buffer update
    if (this._isLiveView()) {
      this.viewer.updateTransparency(this.categoryTransparency);
    } else if (typeof this.viewer.updateSnapshotAttributes === 'function') {
      this.viewer.updateSnapshotAttributes(this.activeViewId, { transparency: this.categoryTransparency });
    }
  },

  _pushOutliersToViewer() {
    if (this._isLiveView()) {
      this.viewer.updateOutlierQuantiles(this.outlierQuantilesArray);
    } else if (typeof this.viewer.updateSnapshotAttributes === 'function') {
      this.viewer.updateSnapshotAttributes(this.activeViewId, { outlierQuantiles: this.outlierQuantilesArray });
    }
  },

  _pushCentroidsToViewer() {
    if (this._isLiveView()) {
      this.viewer.setCentroids({
        positions: this.centroidPositions || new Float32Array(),
        colors: this.centroidColors || new Uint8Array(),
        outlierQuantiles: this.centroidOutliers || new Float32Array()
      });
      this.viewer.setCentroidLabels(this.centroidLabels, this.activeViewId);
    } else if (typeof this.viewer.updateSnapshotAttributes === 'function') {
      this.viewer.updateSnapshotAttributes(this.activeViewId, {
        centroidPositions: this.centroidPositions || new Float32Array(),
        centroidColors: this.centroidColors || new Uint8Array(),
        centroidOutliers: this.centroidOutliers || new Float32Array()
      });
      if (typeof this.viewer.setCentroidLabels === 'function') {
        this.viewer.setCentroidLabels(this.centroidLabels, this.activeViewId);
      }
    }
  },

  _pushOutlierThresholdToViewer(threshold) {
    if (this._isLiveView()) {
      this.viewer.setOutlierThreshold(threshold);
    } else if (typeof this.viewer.updateSnapshotAttributes === 'function') {
      this.viewer.updateSnapshotAttributes(this.activeViewId, { outlierThreshold: threshold });
    }
  },

  _getCentroidsForCurrentDim(field) {
    if (!field) return [];
    const currentDim = this.activeDimensionLevel || 3;
    const centroidsByDim = field.centroidsByDim || {};
    return centroidsByDim[String(currentDim)]
      || centroidsByDim[currentDim]
      || [];
  },

  _rebuildLabelLayerFromCentroids() {
    if (!this.labelLayer || !this.viewer) return;
    const viewKey = String(this.activeViewId || 'live');
    this._removeLabelsForView(viewKey);
    this.centroidLabels = [];
    const field = this.getActiveField ? this.getActiveField() : null;
    const centroids = this._getCentroidsForCurrentDim(field);
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
    // Dataset swap: ensure GPU overlay resources referencing the previous dataset
    // are released before we upload new buffers.
    this.viewer.resetVectorFieldOverlay?.();

    const normalizedFields = (obs?.fields || []).map((field) => ({
      ...field,
      loaded: Boolean(field?.values || field?.codes),
      _loadingPromise: null,
      _normalizedDims: null
    }));
    this.obsData = { ...obs, fields: normalizedFields };
    this._fieldDataCache.clear();
    this._varFieldDataCache.clear();

    this._renameRegistry.clear();
    this._deleteRegistry.clear();
    this._userDefinedFields.clear();
    getFieldRegistry().invalidate();

    this.positionsArray = positions;

    this.pointCount = positions.length / 3;

    this.colorsArray = new Uint8Array(this.pointCount * 4);
    for (let i = 0; i < this.pointCount; i++) {
      const idx = i * 4;
      this.colorsArray[idx] = NEUTRAL_GRAY_UINT8;
      this.colorsArray[idx + 1] = NEUTRAL_GRAY_UINT8;
      this.colorsArray[idx + 2] = NEUTRAL_GRAY_UINT8;
      this.colorsArray[idx + 3] = 255;
    }
    this.outlierQuantilesArray = new Float32Array(this.pointCount);
    this.outlierQuantilesArray.fill(-1.0);
    this.categoryTransparency = new Float32Array(this.pointCount);
    this.categoryTransparency.fill(1.0);
    this.filteredCount = { shown: this.pointCount, total: this.pointCount };

    this.viewer.setData({
      positions,
      colors: this.colorsArray,
      outlierQuantiles: this.outlierQuantilesArray,
      transparency: this.categoryTransparency,
      dimensionLevel: this.activeDimensionLevel
    });

    this.clearCentroids();
    this.viewer.setCentroids({
      positions: new Float32Array(),
      colors: new Uint8Array(),
      outlierQuantiles: new Float32Array(),
      transparency: new Float32Array()
    });
    this.viewer.setCentroidLabels([]);

    this.highlightPages = [];
    this.activePageId = null;
    this._highlightPageIdCounter = 0;
    this.highlightArray = new Uint8Array(this.pointCount);
    this._highlightIdCounter = 0;
    this._cachedHighlightCount = null;
    this._cachedTotalHighlightCount = null;
    this._cachedHighlightLodLevel = null;

    this._resetViewContexts();
  },

  _notifyVisibilityChange() {
    this._invalidateHighlightCountCache(true);
    this.emit('visibility:changed');
  },

  _notifyFieldChange(source, fieldIndex, changeType, detail = null) {
    const event = { source, fieldIndex, changeType, detail };
    this.emit('field:changed', event);
  },

  getVisibilityArray() {
    const total = this.pointCount || 0;
    if (!total) return new Float32Array();

    const alpha = this.categoryTransparency || new Float32Array(total).fill(1.0);
    const applyOutlierFilter = this.isOutlierFilterEnabledForActiveField?.();
    const outliers = applyOutlierFilter ? (this.outlierQuantilesArray || []) : [];
    const outlierThreshold = applyOutlierFilter ? this.getCurrentOutlierThreshold() : 1.0;

    if (!this._visibilityScratch || this._visibilityScratch.length !== total) {
      this._visibilityScratch = new Float32Array(total);
    }

    const mask = this._visibilityScratch;
    for (let i = 0; i < total; i++) {
      let visible = (alpha[i] ?? 0) > 0.001;
      if (visible && applyOutlierFilter) {
        const q = (i < outliers.length) ? outliers[i] : -1;
        if (q >= 0 && q > outlierThreshold) visible = false;
      }
      mask[i] = visible ? 1.0 : 0.0;
    }
    return mask;
  },

  getVisiblePositionsForSmoke() {
    const positions = this.positionsArray;
    if (!positions || !this.pointCount) return new Float32Array();

    const alpha = this.categoryTransparency || new Float32Array(this.pointCount).fill(1.0);
    const applyOutlierFilter = this.isOutlierFilterEnabledForActiveField?.();
    const outliers = applyOutlierFilter ? (this.outlierQuantilesArray || []) : [];
    const outlierThreshold = applyOutlierFilter ? this.getCurrentOutlierThreshold() : 1.0;

    let visibleCount = 0;
    for (let i = 0; i < this.pointCount; i++) {
      if (alpha[i] <= 0.001) continue;
      if (applyOutlierFilter) {
        const q = (i < outliers.length) ? outliers[i] : -1;
        if (q >= 0 && q > outlierThreshold) continue;
      }
      visibleCount++;
    }

    const result = new Float32Array(visibleCount * 3);
    let dst = 0;
    for (let i = 0; i < this.pointCount; i++) {
      if (alpha[i] <= 0.001) continue;
      if (applyOutlierFilter) {
        const q = (i < outliers.length) ? outliers[i] : -1;
        if (q >= 0 && q > outlierThreshold) continue;
      }
      const srcIdx = 3 * i;
      result[dst++] = positions[srcIdx];
      result[dst++] = positions[srcIdx + 1];
      result[dst++] = positions[srcIdx + 2];
    }
    return result;
  }
};
