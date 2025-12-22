/**
 * @fileoverview View context and snapshot management helpers for DataState.
 *
 * Split out of `view-manager.js` to keep modules below the refactoring size
 * limit while preserving behavior and performance characteristics.
 *
 * @module state/managers/view-context-core
 */

import { FieldSource } from '../../utils/field-constants.js';
import { getFieldRegistry } from '../../utils/field-registry.js';

export const viewContextCoreMethods = {
  _removeLabelsForView(viewId) {
    if (!this.labelLayer) return;
    const target = String(viewId ?? this.activeViewId ?? 'live');
    const nodes = Array.from(this.labelLayer.querySelectorAll(`[data-view-id="${target}"]`));
    nodes.forEach((node) => node.remove());
  },

  _cloneFieldState(field) {
    if (!field) return null;
    const clone = { ...field };
    if (field._categoryColors) clone._categoryColors = field._categoryColors.map((c) => (c ? [...c] : c));
    if (field._categoryVisible) clone._categoryVisible = { ...field._categoryVisible };
    if (field._continuousStats) clone._continuousStats = { ...field._continuousStats };
    if (field._continuousFilter) clone._continuousFilter = { ...field._continuousFilter };
    if (field._continuousColorRange) clone._continuousColorRange = { ...field._continuousColorRange };
    if (field._positiveStats) clone._positiveStats = { ...field._positiveStats };
    if (field._useFilterColorRange != null) clone._useFilterColorRange = field._useFilterColorRange;
    if (field._useLogScale != null) clone._useLogScale = field._useLogScale;
    if (field._filterEnabled != null) clone._filterEnabled = field._filterEnabled;
    if (field._categoryFilterEnabled != null) clone._categoryFilterEnabled = field._categoryFilterEnabled;
    if (field._outlierFilterEnabled != null) clone._outlierFilterEnabled = field._outlierFilterEnabled;
    if (field._outlierThreshold != null) clone._outlierThreshold = field._outlierThreshold;
    if (field._categoryCounts) {
      clone._categoryCounts = {
        visible: field._categoryCounts.visible ? [...field._categoryCounts.visible] : null,
        total: field._categoryCounts.total ? [...field._categoryCounts.total] : null,
        visibleTotal: field._categoryCounts.visibleTotal || 0
      };
    }
    clone._loadingPromise = null;
    return clone;
  },

  _cloneObsData(obsData) {
    if (!obsData) return null;
    const fields = (obsData.fields || []).map((f) => this._cloneFieldState(f));
    return { ...obsData, fields };
  },

  _cloneVarData(varData) {
    if (!varData) return null;
    const fields = (varData.fields || []).map((f) => this._cloneFieldState(f));
    return { ...varData, fields };
  },

  _buildContextFromCurrent(id, { cloneArrays = true } = {}) {
    const ctx = {
      id: String(id),
      obsData: this._cloneObsData(this.obsData),
      varData: this._cloneVarData(this.varData),
      activeFieldIndex: this.activeFieldIndex,
      activeVarFieldIndex: this.activeVarFieldIndex,
      activeFieldSource: this.activeFieldSource,
      dimensionLevel: this.activeDimensionLevel
    };

    const wrap = (arr) => {
      if (!arr) return null;
      return cloneArrays ? new Float32Array(arr) : arr;
    };
    ctx.colorsArray = this.colorsArray
      ? (cloneArrays ? new Uint8Array(this.colorsArray) : this.colorsArray)
      : null;
    ctx.categoryTransparency = wrap(this.categoryTransparency);
    ctx.outlierQuantilesArray = wrap(this.outlierQuantilesArray);
    ctx.centroidPositions = wrap(this.centroidPositions);
    ctx.centroidColors = this.centroidColors
      ? (cloneArrays ? new Uint8Array(this.centroidColors) : this.centroidColors)
      : null;
    ctx.centroidOutliers = wrap(this.centroidOutliers);
    ctx.centroidLabels = this.centroidLabels ? [...this.centroidLabels] : [];
    ctx.filteredCount = this.filteredCount
      ? { ...this.filteredCount }
      : { shown: this.pointCount, total: this.pointCount };
    return ctx;
  },

  captureCurrentContext() {
    return this._buildContextFromCurrent(this.activeViewId || 'live', { cloneArrays: true });
  },

  restoreContext(ctx, { preserveSnapshots = true } = {}) {
    if (!ctx) return;
    this.obsData = this._cloneObsData(ctx.obsData);
    this.varData = this._cloneVarData(ctx.varData);
    this.activeFieldIndex = ctx.activeFieldIndex ?? -1;
    this.activeVarFieldIndex = ctx.activeVarFieldIndex ?? -1;
    this.activeFieldSource = ctx.activeFieldSource ?? null;
    this.colorsArray = ctx.colorsArray ? new Uint8Array(ctx.colorsArray) : null;
    this.categoryTransparency = ctx.categoryTransparency ? new Float32Array(ctx.categoryTransparency) : null;
    this.outlierQuantilesArray = ctx.outlierQuantilesArray ? new Float32Array(ctx.outlierQuantilesArray) : null;
    this.centroidPositions = ctx.centroidPositions ? new Float32Array(ctx.centroidPositions) : null;
    this.centroidColors = ctx.centroidColors ? new Uint8Array(ctx.centroidColors) : null;
    this.centroidOutliers = ctx.centroidOutliers ? new Float32Array(ctx.centroidOutliers) : null;
    this.centroidLabels = ctx.centroidLabels ? ctx.centroidLabels.map((c) => (c ? { ...c } : c)) : [];
    this.filteredCount = ctx.filteredCount ? { ...ctx.filteredCount } : { shown: this.pointCount, total: this.pointCount };

    this._applyOverlaysToFields(this.obsData?.fields, FieldSource.OBS);
    this._applyOverlaysToFields(this.varData?.fields, FieldSource.VAR);
    this._injectUserDefinedFields();
    this._ensureActiveSelectionNotDeleted();
    getFieldRegistry().invalidate();

    if (preserveSnapshots) {
      this.activeViewId = 'live';
      this.viewContexts.set('live', this._buildContextFromCurrent('live', { cloneArrays: false }));
    } else {
      this._resetViewContexts();
    }
    this._syncActiveContext();
    this._pushColorsToViewer();
    this._pushTransparencyToViewer();
    this._pushOutliersToViewer();
    this._pushCentroidsToViewer();
    this._pushOutlierThresholdToViewer(this.getCurrentOutlierThreshold());
    this.computeGlobalVisibility();
    this.updateFilterSummary();
  },

  _syncActiveContext() {
    const ctx = this.viewContexts.get(String(this.activeViewId));
    if (!ctx) return;
    ctx.obsData = this._cloneObsData(this.obsData);
    ctx.varData = this._cloneVarData(this.varData);
    ctx.activeFieldIndex = this.activeFieldIndex;
    ctx.activeVarFieldIndex = this.activeVarFieldIndex;
    ctx.activeFieldSource = this.activeFieldSource;
    ctx.colorsArray = this.colorsArray ? new Uint8Array(this.colorsArray) : null;
    ctx.categoryTransparency = this.categoryTransparency ? new Float32Array(this.categoryTransparency) : null;
    ctx.outlierQuantilesArray = this.outlierQuantilesArray ? new Float32Array(this.outlierQuantilesArray) : null;
    ctx.centroidPositions = this.centroidPositions ? new Float32Array(this.centroidPositions) : null;
    ctx.centroidColors = this.centroidColors ? new Uint8Array(this.centroidColors) : null;
    ctx.centroidOutliers = this.centroidOutliers ? new Float32Array(this.centroidOutliers) : null;
    ctx.centroidLabels = this.centroidLabels ? [...this.centroidLabels] : [];
    ctx.filteredCount = this.filteredCount ? { ...this.filteredCount } : { shown: 0, total: 0 };
    ctx.dimensionLevel = this.activeDimensionLevel;
  },

  _resetViewContexts() {
    this.viewContexts.clear();
    const liveCtx = this._buildContextFromCurrent('live', { cloneArrays: false });
    this.viewContexts.set('live', liveCtx);
    this.activeViewId = 'live';
  },

  _computeActiveViewLabel(filtersOverride) {
    const field = this.getActiveField();
    const filters = Array.isArray(filtersOverride)
      ? filtersOverride
      : this.getFilterSummaryLines();
    const firstFilter = filters && filters.length ? filters[0] : null;
    const labelParts = [];
    if (field && field.key) labelParts.push(field.key);
    if (firstFilter && !/No filters active/i.test(firstFilter)) {
      labelParts.push(firstFilter);
    }
    const label = labelParts.join(' • ') || 'All cells';
    return {
      label,
      fieldKey: field ? field.key : null,
      fieldKind: field ? field.kind : null,
      filtersText: filters || []
    };
  },

  _pushActiveViewLabelToViewer(filtersOverride) {
    if (!this.viewer) return;
    const { label, fieldKey, fieldKind, filtersText } =
      this._computeActiveViewLabel(filtersOverride);
    if (String(this.activeViewId) === 'live') {
      if (typeof this.viewer.setLiveViewLabel === 'function') {
        this.viewer.setLiveViewLabel(label);
      }
      return;
    }
    if (typeof this.viewer.updateSnapshotAttributes === 'function') {
      this.viewer.updateSnapshotAttributes(this.activeViewId, {
        label,
        fieldKey,
        fieldKind,
        meta: { filtersText }
      });
    }
  },

  setActiveView(viewId) {
    const key = String(viewId || 'live');
    const ctx = this.viewContexts.get(key) || this.viewContexts.get('live');
    if (!ctx) return null;

    const prevKey = String(this.activeViewId || 'live');
    if (prevKey !== key) {
      const prevCtx = this.viewContexts.get(prevKey);
      if (prevCtx) {
        prevCtx.obsData = this._cloneObsData(this.obsData);
        prevCtx.varData = this._cloneVarData(this.varData);
        prevCtx.activeFieldIndex = this.activeFieldIndex;
        prevCtx.activeVarFieldIndex = this.activeVarFieldIndex;
        prevCtx.activeFieldSource = this.activeFieldSource;
        prevCtx.colorsArray = this.colorsArray ? new Uint8Array(this.colorsArray) : null;
        prevCtx.categoryTransparency = this.categoryTransparency ? new Float32Array(this.categoryTransparency) : null;
        prevCtx.outlierQuantilesArray = this.outlierQuantilesArray ? new Float32Array(this.outlierQuantilesArray) : null;
        prevCtx.centroidPositions = this.centroidPositions ? new Float32Array(this.centroidPositions) : null;
        prevCtx.centroidColors = this.centroidColors ? new Uint8Array(this.centroidColors) : null;
        prevCtx.centroidOutliers = this.centroidOutliers ? new Float32Array(this.centroidOutliers) : null;
        prevCtx.centroidLabels = this.centroidLabels ? this.centroidLabels.map(c => c ? { ...c } : c) : [];
        prevCtx.filteredCount = this.filteredCount ? { ...this.filteredCount } : { shown: this.pointCount, total: this.pointCount };
        prevCtx.dimensionLevel = this.activeDimensionLevel;
      }
    }

    this.activeViewId = ctx.id;
    if (this.viewer && typeof this.viewer.setViewLayout === 'function') {
      this.viewer.setViewLayout('grid', this.activeViewId);
    }
    this.obsData = this._cloneObsData(ctx.obsData);
    this.varData = this._cloneVarData(ctx.varData);
    this.activeFieldIndex = ctx.activeFieldIndex ?? -1;
    this.activeVarFieldIndex = ctx.activeVarFieldIndex ?? -1;
    this.activeFieldSource = ctx.activeFieldSource ?? null;
    this.colorsArray = ctx.colorsArray ? new Uint8Array(ctx.colorsArray) : null;
    this.categoryTransparency = ctx.categoryTransparency ? new Float32Array(ctx.categoryTransparency) : null;
    this.outlierQuantilesArray = ctx.outlierQuantilesArray ? new Float32Array(ctx.outlierQuantilesArray) : null;
    this.centroidPositions = ctx.centroidPositions ? new Float32Array(ctx.centroidPositions) : null;
    this.centroidColors = ctx.centroidColors ? new Uint8Array(ctx.centroidColors) : null;
    this.centroidOutliers = ctx.centroidOutliers ? new Float32Array(ctx.centroidOutliers) : null;
    this.centroidLabels = ctx.centroidLabels ? ctx.centroidLabels.map(c => c ? { ...c } : c) : [];
    this.filteredCount = ctx.filteredCount ? { ...ctx.filteredCount } : { shown: this.pointCount, total: this.pointCount };

    this._applyOverlaysToFields(this.obsData?.fields, FieldSource.OBS);
    this._applyOverlaysToFields(this.varData?.fields, FieldSource.VAR);
    this._injectUserDefinedFields();
    this._ensureActiveSelectionNotDeleted();
    getFieldRegistry().invalidate();

    const viewDimLevel = ctx.dimensionLevel ?? this.dimensionManager?.getDefaultDimension() ?? 3;
    if (viewDimLevel !== this.activeDimensionLevel) {
      this.activeDimensionLevel = viewDimLevel;
      if (this.dimensionManager) {
        this.dimensionManager.setViewDimension(ctx.id, viewDimLevel);
      }
      this._notifyDimensionChange();
    }

    this._reinitializeActiveField();
    this._rebuildLabelLayerFromCentroids();
    this._pushColorsToViewer();
    this._pushTransparencyToViewer();
    this._pushOutliersToViewer();
    this._pushCentroidsToViewer();
    this._pushOutlierThresholdToViewer(this.getCurrentOutlierThreshold());
    this.updateFilterSummary();
    this._syncActiveContext();
    return this.activeViewId;
  },

  _reinitializeActiveField() {
    const field = this.getActiveField();
    if (!field || !field.loaded) return;

    if (field.kind === 'continuous') {
      this.ensureContinuousMetadata(field);
    } else if (field.kind === 'category') {
      this.ensureCategoryMetadata(field);
      const counts = this.computeCategoryCountsForField(field);
      if (counts) {
        field._categoryCounts = counts;
        this._activeCategoryCounts = counts;
      }
    }
  },

  createViewFromActive(viewId) {
    const ctx = this._buildContextFromCurrent(viewId, { cloneArrays: true });
    this.viewContexts.set(String(viewId), ctx);
  },

  removeView(viewId) {
    const key = String(viewId);
    this.viewContexts.delete(key);
    if (String(this.activeViewId) === key) {
      this.setActiveView('live');
    }
  },

  clearSnapshotViews() {
    const liveCtx = this.viewContexts.get('live') || this._buildContextFromCurrent('live', { cloneArrays: false });
    this.viewContexts.clear();
    this.viewContexts.set('live', liveCtx);
    this.setActiveView('live');
  },

  syncSnapshotContexts(snapshotIds) {
    const keep = new Set((snapshotIds || []).map((id) => String(id)));
    const keys = Array.from(this.viewContexts.keys());
    for (const key of keys) {
      if (key === 'live') continue;
      if (!keep.has(String(key))) this.viewContexts.delete(key);
    }
    if (!keep.has(String(this.activeViewId)) && this.activeViewId !== 'live') {
      this.setActiveView('live');
    }
  },

  getActiveViewId() {
    return this.activeViewId;
  },

  _isLiveView() {
    return String(this.activeViewId) === 'live';
  }
};

