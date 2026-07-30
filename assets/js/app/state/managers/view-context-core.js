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
import {
  POINT_VISIBILITY_THRESHOLD,
} from '../../../rendering/alpha-visibility.js';

function cloneSnapshotPointAttributes(config, pointCount) {
  if (
    config === null ||
    typeof config !== 'object' ||
    Array.isArray(config)
  ) {
    throw new TypeError(
      'Snapshot context attributes require one configuration object.'
    );
  }
  if (
    !(config.colors instanceof Uint8Array) ||
    config.colors.length !== pointCount * 4
  ) {
    throw new TypeError(
      'Snapshot context colors must be an exact dataset-length Uint8 RGBA array.'
    );
  }
  if (
    !(config.transparency instanceof Float32Array) ||
    config.transparency.length !== pointCount
  ) {
    throw new TypeError(
      'Snapshot context transparency must be an exact dataset-length Float32 array.'
    );
  }
  for (let index = 0; index < config.transparency.length; index += 1) {
    const alpha = config.transparency[index];
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
      throw new RangeError(
        `Snapshot context transparency ${index} must be finite and in [0, 1].`
      );
    }
  }

  const hasCentroidPositions = config.centroidPositions !== null;
  const hasCentroidColors = config.centroidColors !== null;
  if (hasCentroidPositions !== hasCentroidColors) {
    throw new TypeError(
      'Snapshot context centroid positions and colors must be published together.'
    );
  }
  let centroidPositions = null;
  let centroidColors = null;
  if (hasCentroidPositions) {
    if (
      !(config.centroidPositions instanceof Float32Array) ||
      config.centroidPositions.length % 3 !== 0
    ) {
      throw new TypeError(
        'Snapshot context centroids must contain complete Float32 XYZ triples.'
      );
    }
    const centroidCount = config.centroidPositions.length / 3;
    if (
      !(config.centroidColors instanceof Uint8Array) ||
      config.centroidColors.length !== centroidCount * 4
    ) {
      throw new TypeError(
        'Snapshot context centroid colors must contain one Uint8 RGBA value per centroid.'
      );
    }
    for (
      let index = 0;
      index < config.centroidPositions.length;
      index += 1
    ) {
      if (!Number.isFinite(config.centroidPositions[index])) {
        throw new RangeError(
          `Snapshot context centroid position ${index} must be finite.`
        );
      }
    }
    centroidPositions = new Float32Array(config.centroidPositions);
    centroidColors = new Uint8Array(config.centroidColors);
  }
  return {
    colors: new Uint8Array(config.colors),
    transparency: new Float32Array(config.transparency),
    centroidPositions,
    centroidColors,
  };
}

function exactTypedArrayEqual(left, right) {
  if (
    !ArrayBuffer.isView(left) ||
    !ArrayBuffer.isView(right) ||
    left?.constructor !== right?.constructor ||
    left.length !== right.length
  ) {
    return left === right;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

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
    ctx.cellVisibilityMask = wrap(this.cellVisibilityMask);
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

  _cloneViewContext(source, id, { cloneArrays = true } = {}) {
    if (
      source === null ||
      typeof source !== 'object' ||
      Array.isArray(source) ||
      typeof source.id !== 'string' ||
      source.id.length === 0 ||
      source.id.trim() !== source.id
    ) {
      throw new TypeError(
        'View-context cloning requires one exact published source context.'
      );
    }
    const wrapFloat32 = value => {
      if (value === null || value === undefined) return null;
      if (!(value instanceof Float32Array)) {
        throw new TypeError(
          `View "${source.id}" contains a non-Float32 numeric context buffer.`
        );
      }
      return cloneArrays ? new Float32Array(value) : value;
    };
    const wrapUint8 = value => {
      if (value === null || value === undefined) return null;
      if (!(value instanceof Uint8Array)) {
        throw new TypeError(
          `View "${source.id}" contains a non-Uint8 color context buffer.`
        );
      }
      return cloneArrays ? new Uint8Array(value) : value;
    };
    return {
      id,
      obsData: this._cloneObsData(source.obsData),
      varData: this._cloneVarData(source.varData),
      activeFieldIndex: source.activeFieldIndex,
      activeVarFieldIndex: source.activeVarFieldIndex,
      activeFieldSource: source.activeFieldSource,
      dimensionLevel: source.dimensionLevel,
      colorsArray: wrapUint8(source.colorsArray),
      categoryTransparency: wrapFloat32(source.categoryTransparency),
      cellVisibilityMask: wrapFloat32(source.cellVisibilityMask),
      outlierQuantilesArray: wrapFloat32(source.outlierQuantilesArray),
      centroidPositions: wrapFloat32(source.centroidPositions),
      centroidColors: wrapUint8(source.centroidColors),
      centroidOutliers: wrapFloat32(source.centroidOutliers),
      centroidLabels: Array.isArray(source.centroidLabels)
        ? source.centroidLabels.map(label => (
            label === null || label === undefined
              ? label
              : { ...label }
          ))
        : [],
      filteredCount: source.filteredCount
        ? { ...source.filteredCount }
        : { shown: this.pointCount, total: this.pointCount },
    };
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
    this.cellVisibilityMask = ctx.cellVisibilityMask ? new Float32Array(ctx.cellVisibilityMask) : null;
    this.outlierQuantilesArray = ctx.outlierQuantilesArray ? new Float32Array(ctx.outlierQuantilesArray) : null;
    this.centroidPositions = ctx.centroidPositions ? new Float32Array(ctx.centroidPositions) : null;
    this.centroidColors = ctx.centroidColors ? new Uint8Array(ctx.centroidColors) : null;
    this.centroidOutliers = ctx.centroidOutliers ? new Float32Array(ctx.centroidOutliers) : null;
    this.centroidLabels = ctx.centroidLabels ? ctx.centroidLabels.map((c) => (c ? { ...c } : c)) : [];
    this.filteredCount = ctx.filteredCount ? { ...ctx.filteredCount } : { shown: this.pointCount, total: this.pointCount };

    this._applyOverlaysToFields(
      this.obsData === null ? null : this.obsData.fields,
      FieldSource.OBS
    );
    this._applyOverlaysToFields(
      this.varData === null ? null : this.varData.fields,
      FieldSource.VAR
    );
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
    this._pushCentroidsToViewer();
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
    ctx.cellVisibilityMask = this.cellVisibilityMask ? new Float32Array(this.cellVisibilityMask) : null;
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
    if (typeof viewId !== 'string' || viewId.trim().length === 0) {
      throw new TypeError('Active view id must be a non-empty string.');
    }
    if (!(this.viewContexts instanceof Map)) {
      throw new TypeError('Active view selection requires the exact view-context map.');
    }
    if (!this.viewContexts.has(viewId)) {
      throw new RangeError(`Active view "${viewId}" does not exist.`);
    }
    const key = viewId;
    const ctx = this.viewContexts.get(key);
    if (
      ctx === null
      || typeof ctx !== 'object'
      || Array.isArray(ctx)
      || ctx.id !== key
    ) {
      throw new TypeError(`Active view "${key}" has an invalid context.`);
    }

    const prevKey = this.activeViewId;
    if (
      typeof prevKey !== 'string'
      || prevKey.trim().length === 0
      || !this.viewContexts.has(prevKey)
    ) {
      throw new Error('The current active view does not have an exact context.');
    }
    const prevCtx = this.viewContexts.get(prevKey);
    if (
      prevCtx === null
      || typeof prevCtx !== 'object'
      || Array.isArray(prevCtx)
      || prevCtx.id !== prevKey
    ) {
      throw new TypeError(`Current active view "${prevKey}" has an invalid context.`);
    }
    if (
      !(this.cellVisibilityMask instanceof Float32Array)
      || this.cellVisibilityMask.length !== this.pointCount
      || !(ctx.cellVisibilityMask instanceof Float32Array)
      || ctx.cellVisibilityMask.length !== this.pointCount
    ) {
      throw new TypeError(
        'Active view selection requires complete per-view cell visibility masks.'
      );
    }
    if (prevKey === key) {
      return key;
    }
    const previousCellVisibilityMask = new Float32Array(this.cellVisibilityMask);
    const nextCellVisibilityMask = new Float32Array(ctx.cellVisibilityMask);

    prevCtx.obsData = this._cloneObsData(this.obsData);
    prevCtx.varData = this._cloneVarData(this.varData);
    prevCtx.activeFieldIndex = this.activeFieldIndex;
    prevCtx.activeVarFieldIndex = this.activeVarFieldIndex;
    prevCtx.activeFieldSource = this.activeFieldSource;
    prevCtx.colorsArray = this.colorsArray ? new Uint8Array(this.colorsArray) : null;
    prevCtx.categoryTransparency = this.categoryTransparency ? new Float32Array(this.categoryTransparency) : null;
    prevCtx.cellVisibilityMask = previousCellVisibilityMask;
    prevCtx.outlierQuantilesArray = this.outlierQuantilesArray ? new Float32Array(this.outlierQuantilesArray) : null;
    prevCtx.centroidPositions = this.centroidPositions ? new Float32Array(this.centroidPositions) : null;
    prevCtx.centroidColors = this.centroidColors ? new Uint8Array(this.centroidColors) : null;
    prevCtx.centroidOutliers = this.centroidOutliers ? new Float32Array(this.centroidOutliers) : null;
    prevCtx.centroidLabels = this.centroidLabels ? this.centroidLabels.map(c => c ? { ...c } : c) : [];
    prevCtx.filteredCount = this.filteredCount ? { ...this.filteredCount } : { shown: this.pointCount, total: this.pointCount };
    prevCtx.dimensionLevel = this.activeDimensionLevel;

    this.activeViewId = key;
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
    this.cellVisibilityMask = nextCellVisibilityMask;
    this.outlierQuantilesArray = ctx.outlierQuantilesArray ? new Float32Array(ctx.outlierQuantilesArray) : null;
    this.centroidPositions = ctx.centroidPositions ? new Float32Array(ctx.centroidPositions) : null;
    this.centroidColors = ctx.centroidColors ? new Uint8Array(ctx.centroidColors) : null;
    this.centroidOutliers = ctx.centroidOutliers ? new Float32Array(ctx.centroidOutliers) : null;
    this.centroidLabels = ctx.centroidLabels ? ctx.centroidLabels.map(c => c ? { ...c } : c) : [];
    this.filteredCount = ctx.filteredCount ? { ...ctx.filteredCount } : { shown: this.pointCount, total: this.pointCount };

    this._applyOverlaysToFields(
      this.obsData === null ? null : this.obsData.fields,
      FieldSource.OBS
    );
    this._applyOverlaysToFields(
      this.varData === null ? null : this.varData.fields,
      FieldSource.VAR
    );
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
    this._pushCentroidsToViewer();
    this.updateFilterSummary();
    this._syncActiveContext();
    this._notifyVisibilityChange();
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

  createViewFromSource(sourceViewId, viewId) {
    for (const [label, value] of [
      ['Snapshot source view id', sourceViewId],
      ['Snapshot view id', viewId],
    ]) {
      if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.trim() !== value
      ) {
        throw new TypeError(
          `${label} must be a non-empty, exactly trimmed string.`
        );
      }
    }
    if (!(this.viewContexts instanceof Map)) {
      throw new TypeError(
        'Snapshot context publication requires the exact view-context map.'
      );
    }
    if (viewId === 'live') {
      throw new RangeError('A snapshot context cannot replace the live view.');
    }
    if (this.viewContexts.has(viewId)) {
      throw new RangeError(`View context "${viewId}" already exists.`);
    }
    const source = this.viewContexts.get(sourceViewId);
    if (
      source === null ||
      typeof source !== 'object' ||
      source.id !== sourceViewId
    ) {
      throw new RangeError(
        `Snapshot source view "${sourceViewId}" does not exist.`
      );
    }
    const ctx = viewContextCoreMethods._cloneViewContext.call(
      this,
      source,
      viewId,
      { cloneArrays: true }
    );
    this.viewContexts.set(viewId, ctx);
    return ctx;
  },

  createViewFromActive(viewId) {
    return viewContextCoreMethods.createViewFromSource.call(
      this,
      String(this.activeViewId),
      viewId
    );
  },

  applySnapshotConfigToView(viewId, config) {
    if (
      typeof viewId !== 'string' ||
      viewId.length === 0 ||
      viewId.trim() !== viewId ||
      viewId === 'live'
    ) {
      throw new TypeError(
        'Snapshot context configuration requires one exact snapshot id.'
      );
    }
    const context = this.viewContexts.get(viewId);
    if (
      context === null ||
      typeof context !== 'object' ||
      context.id !== viewId
    ) {
      throw new RangeError(
        `Snapshot context "${viewId}" does not exist.`
      );
    }
    if (
      !Number.isSafeInteger(this.pointCount) ||
      this.pointCount < 0
    ) {
      throw new RangeError(
        'Snapshot context publication requires a non-negative point count.'
      );
    }
    const attributes = cloneSnapshotPointAttributes(
      config,
      this.pointCount
    );
    const centroidsUnchanged =
      exactTypedArrayEqual(
        context.centroidPositions,
        attributes.centroidPositions
      ) &&
      exactTypedArrayEqual(
        context.centroidColors,
        attributes.centroidColors
      );

    context.colorsArray = attributes.colors;
    context.categoryTransparency = attributes.transparency;
    let shown = 0;
    for (let index = 0; index < this.pointCount; index += 1) {
      const visible =
        attributes.transparency[index] >= POINT_VISIBILITY_THRESHOLD;
      if (visible) shown += 1;
    }
    context.centroidPositions = attributes.centroidPositions;
    context.centroidColors = attributes.centroidColors;
    if (!centroidsUnchanged) {
      const centroidCount =
        attributes.centroidPositions === null
          ? 0
          : attributes.centroidPositions.length / 3;
      context.centroidOutliers = new Float32Array(centroidCount);
      context.centroidOutliers.fill(-1);
      context.centroidLabels = [];
    }
    context.filteredCount = {
      shown,
      total: this.pointCount,
    };
    return context;
  },

  removeView(viewId) {
    if (
      typeof viewId !== 'string' ||
      viewId.length === 0 ||
      viewId.trim() !== viewId
    ) {
      throw new TypeError(
        'Removed view id must be a non-empty, exactly trimmed string.'
      );
    }
    const key = viewId;
    if (key === 'live') {
      throw new RangeError('The live view context cannot be removed.');
    }
    const failures = [];
    const attempt = operation => {
      try {
        return operation();
      } catch (error) {
        failures.push(error);
        return undefined;
      }
    };
    if (this.activeViewId === key) {
      attempt(() => this.setActiveView('live'));
    }
    const dimensionManager = this.dimensionManager;
    if (dimensionManager !== null && dimensionManager !== undefined) {
      if (typeof dimensionManager.removeView !== 'function') {
        failures.push(
          new TypeError(
            'View removal requires DimensionManager.removeView().'
          )
        );
      } else {
        attempt(() => dimensionManager.removeView(key));
      }
    }
    let contextRemoved = false;
    attempt(() => {
      contextRemoved = this.viewContexts.delete(key);
    });
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `View "${key}" retirement was incomplete.`
      );
    }
    return contextRemoved;
  },

  clearSnapshotViews() {
    viewContextCoreMethods.syncSnapshotContexts.call(this, []);
  },

  syncSnapshotContexts(snapshotIds) {
    const keep = new Set((snapshotIds || []).map((id) => String(id)));
    const failures = [];
    if (!keep.has(String(this.activeViewId)) && this.activeViewId !== 'live') {
      try {
        this.setActiveView('live');
      } catch (error) {
        failures.push(error);
      }
    }
    const keys = Array.from(this.viewContexts.keys());
    for (const key of keys) {
      if (key === 'live') continue;
      if (!keep.has(String(key))) {
        try {
          viewContextCoreMethods.removeView.call(this, key);
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        'Snapshot context reconciliation was incomplete.'
      );
    }
  },

  getActiveViewId() {
    return this.activeViewId;
  },

  _isLiveView() {
    return String(this.activeViewId) === 'live';
  }
};
