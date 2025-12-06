// Data/state manager: loads obs data, computes colors/filters, and feeds buffers to the viewer.
import {
  normalizePositions,
  applyNormalizationToCentroids
} from '../rendering/gl-utils.js';
import {
  rgbToCss,
  COLOR_PICKER_PALETTE,
  CONTINUOUS_COLORMAPS,
  getCategoryColor,
  getColormap,
  getCssStopsForColormap,
  sampleContinuousColormap
} from '../data/palettes.js';

const NEUTRAL_GRAY_UINT8 = 211; // lightgray default when no field is selected (0-255)
const NEUTRAL_GRAY = NEUTRAL_GRAY_UINT8 / 255; // normalized for legacy compatibility
const NEUTRAL_RGB = [NEUTRAL_GRAY, NEUTRAL_GRAY, NEUTRAL_GRAY];

export function createDataState({ viewer, labelLayer }) {
  return new DataState(viewer, labelLayer);
}

class DataState {
  constructor(viewer, labelLayer) {
    this.viewer = viewer;
    this.labelLayer = labelLayer;
    this.fieldLoader = null;
    this.varFieldLoader = null;

    this.pointCount = 0;
    this.positionsArray = null;       // normalized positions used for smoke density
    this.colorsArray = null;
    this.outlierQuantilesArray = null;
    this.categoryTransparency = null;
    this.obsData = null;
    this.varData = null;
    this.activeFieldIndex = -1;
    this.activeVarFieldIndex = -1;
    this.activeFieldSource = null; // 'obs', 'var', or null
    this.filteredCount = { shown: 0, total: 0 };

    this.centroidCount = 0;
    this.centroidPositions = null;
    this.centroidColors = null; // RGBA uint8 (alpha packed in)
    this.centroidLabels = [];
    this.centroidOutliers = null;

    this._visibilityChangeCallback = null; // called when filters / visibility change
    this._visibilityChangeCallbacks = new Set();
    this._visibilityScratch = null; // reusable mask for connectivity visibility
    this._activeCategoryCounts = null;
    this.activeViewId = 'live';
    this.viewContexts = new Map(); // viewId -> per-view context (arrays + field state)
    this._fieldDataCache = new Map(); // field.key -> loaded arrays (shared across views)
    this._varFieldDataCache = new Map(); // var.field.key -> loaded arrays

    // Cell highlighting/selection state - multi-page system
    // Each page contains its own independent set of highlight groups
    this.highlightPages = []; // Array of { id, name, highlightedGroups: [] }
    this.activePageId = null; // Currently active page ID
    this._highlightPageIdCounter = 0;
    this.highlightArray = null; // Uint8Array per-point highlight intensity (0-255)
    this._highlightIdCounter = 0;
    this._highlightChangeCallbacks = new Set();
    this._highlightPageChangeCallbacks = new Set(); // Callbacks when pages change (add/remove/rename/switch)
  }

  // --- View context helpers ---------------------------------------------------

  _removeLabelsForView(viewId) {
    if (!this.labelLayer) return;
    const target = String(viewId ?? this.activeViewId ?? 'live');
    const nodes = Array.from(this.labelLayer.querySelectorAll(`[data-view-id="${target}"]`));
    nodes.forEach((node) => node.remove());
  }

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
  }

  _cloneObsData(obsData) {
    if (!obsData) return null;
    const fields = (obsData.fields || []).map((f) => this._cloneFieldState(f));
    return { ...obsData, fields };
  }

  _cloneVarData(varData) {
    if (!varData) return null;
    const fields = (varData.fields || []).map((f) => this._cloneFieldState(f));
    return { ...varData, fields };
  }

  _buildContextFromCurrent(id, { cloneArrays = true } = {}) {
    const ctx = {
      id: String(id),
      obsData: this._cloneObsData(this.obsData),
      varData: this._cloneVarData(this.varData),
      activeFieldIndex: this.activeFieldIndex,
      activeVarFieldIndex: this.activeVarFieldIndex,
      activeFieldSource: this.activeFieldSource
    };

    const wrap = (arr) => {
      if (!arr) return null;
      return cloneArrays ? new Float32Array(arr) : arr;
    };
    // colorsArray is now Uint8Array
    ctx.colorsArray = this.colorsArray
      ? (cloneArrays ? new Uint8Array(this.colorsArray) : this.colorsArray)
      : null;
    ctx.categoryTransparency = wrap(this.categoryTransparency);
    ctx.outlierQuantilesArray = wrap(this.outlierQuantilesArray);
    ctx.centroidPositions = wrap(this.centroidPositions);
    // centroidColors is Uint8Array RGBA (alpha packed in)
    ctx.centroidColors = this.centroidColors
      ? (cloneArrays ? new Uint8Array(this.centroidColors) : this.centroidColors)
      : null;
    ctx.centroidOutliers = wrap(this.centroidOutliers);
    ctx.centroidLabels = this.centroidLabels ? [...this.centroidLabels] : [];
    ctx.filteredCount = this.filteredCount
      ? { ...this.filteredCount }
      : { shown: this.pointCount, total: this.pointCount };
    return ctx;
  }

  _syncActiveContext() {
    const ctx = this.viewContexts.get(String(this.activeViewId));
    if (!ctx) return;
    ctx.obsData = this.obsData;
    ctx.varData = this.varData;
    ctx.activeFieldIndex = this.activeFieldIndex;
    ctx.activeVarFieldIndex = this.activeVarFieldIndex;
    ctx.activeFieldSource = this.activeFieldSource;
    ctx.colorsArray = this.colorsArray;
    ctx.categoryTransparency = this.categoryTransparency;
    ctx.outlierQuantilesArray = this.outlierQuantilesArray;
    ctx.centroidPositions = this.centroidPositions;
    ctx.centroidColors = this.centroidColors; // RGBA uint8
    ctx.centroidOutliers = this.centroidOutliers;
    ctx.centroidLabels = this.centroidLabels;
    ctx.filteredCount = this.filteredCount;
  }

  _resetViewContexts() {
    this.viewContexts.clear();
    const liveCtx = this._buildContextFromCurrent('live', { cloneArrays: false });
    this.viewContexts.set('live', liveCtx);
    this.activeViewId = 'live';
  }

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
  }

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
  }

  setActiveView(viewId) {
    const key = String(viewId || 'live');
    const ctx = this.viewContexts.get(key) || this.viewContexts.get('live');
    if (!ctx) return null;
    this.activeViewId = ctx.id;
    if (this.viewer && typeof this.viewer.setViewLayout === 'function') {
      this.viewer.setViewLayout('grid', this.activeViewId);
    }
    this.obsData = ctx.obsData;
    this.varData = ctx.varData;
    this.activeFieldIndex = ctx.activeFieldIndex ?? -1;
    this.activeVarFieldIndex = ctx.activeVarFieldIndex ?? -1;
    this.activeFieldSource = ctx.activeFieldSource ?? null;
    this.colorsArray = ctx.colorsArray;
    this.categoryTransparency = ctx.categoryTransparency;
    this.outlierQuantilesArray = ctx.outlierQuantilesArray;
    this.centroidPositions = ctx.centroidPositions;
    this.centroidColors = ctx.centroidColors; // RGBA uint8
    this.centroidOutliers = ctx.centroidOutliers;
    this.centroidLabels = ctx.centroidLabels || [];
    this.filteredCount = ctx.filteredCount || { shown: this.pointCount, total: this.pointCount };
    this._rebuildLabelLayerFromCentroids();
    this._pushColorsToViewer();
    this._pushTransparencyToViewer();
    this._pushOutliersToViewer();
    this._pushCentroidsToViewer();
    this._pushOutlierThresholdToViewer(this.getCurrentOutlierThreshold());
    this.updateFilterSummary();
    this._syncActiveContext();
    return this.activeViewId;
  }

  createViewFromActive(viewId) {
    const ctx = this._buildContextFromCurrent(viewId, { cloneArrays: true });
    this.viewContexts.set(String(viewId), ctx);
  }

  removeView(viewId) {
    const key = String(viewId);
    this.viewContexts.delete(key);
    if (String(this.activeViewId) === key) {
      this.setActiveView('live');
    }
  }

  clearSnapshotViews() {
    const liveCtx = this.viewContexts.get('live') || this._buildContextFromCurrent('live', { cloneArrays: false });
    this.viewContexts.clear();
    this.viewContexts.set('live', liveCtx);
    this.setActiveView('live');
  }

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
  }

  getActiveViewId() {
    return this.activeViewId;
  }

  _isLiveView() {
    return String(this.activeViewId) === 'live';
  }

  _pushColorsToViewer() {
    if (this._isLiveView()) {
      this.viewer.updateColors(this.colorsArray);
    } else if (typeof this.viewer.updateSnapshotAttributes === 'function') {
      this.viewer.updateSnapshotAttributes(this.activeViewId, { colors: this.colorsArray });
    }
  }

  _pushTransparencyToViewer() {
    // Alpha is now packed in colorsArray, so push colors when transparency changes
    this._pushColorsToViewer();
    if (this._isLiveView()) {
      this.viewer.updateTransparency(this.categoryTransparency);
    } else if (typeof this.viewer.updateSnapshotAttributes === 'function') {
      this.viewer.updateSnapshotAttributes(this.activeViewId, { transparency: this.categoryTransparency });
    }
  }

  _pushOutliersToViewer() {
    if (this._isLiveView()) {
      this.viewer.updateOutlierQuantiles(this.outlierQuantilesArray);
    } else if (typeof this.viewer.updateSnapshotAttributes === 'function') {
      this.viewer.updateSnapshotAttributes(this.activeViewId, { outlierQuantiles: this.outlierQuantilesArray });
    }
  }

  _pushCentroidsToViewer() {
    if (this._isLiveView()) {
      this.viewer.setCentroids({
        positions: this.centroidPositions || new Float32Array(),
        colors: this.centroidColors || new Uint8Array(), // RGBA uint8 (alpha packed in)
        outlierQuantiles: this.centroidOutliers || new Float32Array()
      });
      this.viewer.setCentroidLabels(this.centroidLabels, this.activeViewId);
    } else if (typeof this.viewer.updateSnapshotAttributes === 'function') {
      this.viewer.updateSnapshotAttributes(this.activeViewId, {
        centroidPositions: this.centroidPositions || new Float32Array(),
        centroidColors: this.centroidColors || new Uint8Array(), // RGBA uint8 (alpha packed in)
        centroidOutliers: this.centroidOutliers || new Float32Array()
      });
      if (typeof this.viewer.setCentroidLabels === 'function') {
        this.viewer.setCentroidLabels(this.centroidLabels, this.activeViewId);
      }
    }
  }

  _pushOutlierThresholdToViewer(threshold) {
    if (this._isLiveView()) {
      this.viewer.setOutlierThreshold(threshold);
    } else if (typeof this.viewer.updateSnapshotAttributes === 'function') {
      this.viewer.updateSnapshotAttributes(this.activeViewId, { outlierThreshold: threshold });
    }
  }

  _rebuildLabelLayerFromCentroids() {
    if (!this.labelLayer || !this.viewer) return;
    const viewKey = String(this.activeViewId || 'live');
    this._removeLabelsForView(viewKey);
    this.centroidLabels = [];
    const field = this.getActiveField ? this.getActiveField() : null;
    if (!field || field.kind !== 'category' || !this.centroidPositions || !field.centroids) {
      this.viewer.setCentroidLabels([], viewKey);
      return;
    }
    const centroids = field.centroids || [];
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
  }

  initScene(positions, obs) {
    const normalizedFields = (obs?.fields || []).map((field) => ({
      ...field,
      loaded: Boolean(field?.values || field?.codes),
      _loadingPromise: null
    }));
    this.obsData = { ...obs, fields: normalizedFields };
    this._fieldDataCache.clear();
    this._varFieldDataCache.clear();

    // Normalize in place to [-1,1]^3 and remember the array
    const norm = normalizePositions(positions);
    this.positionsArray = positions;
    applyNormalizationToCentroids(this.obsData, norm);

    this.pointCount = positions.length / 3;

    this.colorsArray = new Uint8Array(this.pointCount * 4); // RGBA packed as uint8
    // Fill with neutral gray (RGB) and full alpha
    for (let i = 0; i < this.pointCount; i++) {
      const idx = i * 4;
      this.colorsArray[idx] = NEUTRAL_GRAY_UINT8;
      this.colorsArray[idx + 1] = NEUTRAL_GRAY_UINT8;
      this.colorsArray[idx + 2] = NEUTRAL_GRAY_UINT8;
      this.colorsArray[idx + 3] = 255; // full alpha
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
      transparency: this.categoryTransparency
    });

    this.clearCentroids();
    this.viewer.setCentroids({
      positions: new Float32Array(),
      colors: new Uint8Array(), // RGBA uint8 (matches centroid attribute format)
      outlierQuantiles: new Float32Array(),
      transparency: new Float32Array()
    });
    this.viewer.setCentroidLabels([]);
    this._resetViewContexts();
  }

  // --- Volumetric smoke helpers -------------------------------------------------

  setVisibilityChangeCallback(callback) {
    this._visibilityChangeCallbacks = new Set();
    if (typeof callback === 'function') {
      this._visibilityChangeCallbacks.add(callback);
    }
  }

  addVisibilityChangeCallback(callback) {
    if (!this._visibilityChangeCallbacks) {
      this._visibilityChangeCallbacks = new Set();
    }
    if (typeof callback === 'function') {
      this._visibilityChangeCallbacks.add(callback);
    }
  }

  _notifyVisibilityChange() {
    if (!this._visibilityChangeCallbacks || this._visibilityChangeCallbacks.size === 0) return;
    this._visibilityChangeCallbacks.forEach((cb) => {
      try { cb(); }
      catch (err) { console.error('Visibility change callback failed', err); }
    });
  }

  // Returns per-point visibility (0 = hidden, 1 = visible) including outlier filtering
  getVisibilityArray() {
    const total = this.pointCount || 0;
    if (!total) return new Float32Array();

    const alpha = this.categoryTransparency || new Float32Array(total).fill(1.0);
    const outliers = this.outlierQuantilesArray || [];
    const outlierThreshold = this.getCurrentOutlierThreshold();

    if (!this._visibilityScratch || this._visibilityScratch.length !== total) {
      this._visibilityScratch = new Float32Array(total);
    }

    const mask = this._visibilityScratch;
    for (let i = 0; i < total; i++) {
      let visible = (alpha[i] ?? 0) > 0.001;
      if (visible) {
        const q = (i < outliers.length) ? outliers[i] : -1;
        if (q >= 0 && q > outlierThreshold) visible = false;
      }
      mask[i] = visible ? 1.0 : 0.0;
    }
    return mask;
  }

  // Returns normalized positions for all points currently visible in the scatter
  // (respecting category filters, continuous filters, and outlier filtering).
  getVisiblePositionsForSmoke() {
    const positions = this.positionsArray;
    if (!positions || !this.pointCount) return new Float32Array();

    const alpha = this.categoryTransparency || new Float32Array(this.pointCount).fill(1.0);
    const outliers = this.outlierQuantilesArray || [];
    const outlierThreshold = this.getCurrentOutlierThreshold();

    let visibleCount = 0;
    for (let i = 0; i < this.pointCount; i++) {
      if (alpha[i] <= 0.001) continue;
      const q = (i < outliers.length) ? outliers[i] : -1;
      if (q >= 0 && q > outlierThreshold) continue;
      visibleCount++;
    }

    const result = new Float32Array(visibleCount * 3);
    let dst = 0;
    for (let i = 0; i < this.pointCount; i++) {
      if (alpha[i] <= 0.001) continue;
      const q = (i < outliers.length) ? outliers[i] : -1;
      if (q >= 0 && q > outlierThreshold) continue;
      const srcIdx = 3 * i;
      result[dst++] = positions[srcIdx];
      result[dst++] = positions[srcIdx + 1];
      result[dst++] = positions[srcIdx + 2];
    }
    return result;
  }

  // --- Existing API -------------------------------------------------------------

  getFields() {
    return this.obsData?.fields || [];
  }

  getVarFields() {
    return this.varData?.fields || [];
  }

  getActiveField() {
    if (this.activeFieldSource === 'var') {
      return this.getVarFields()[this.activeVarFieldIndex];
    }
    return this.getFields()[this.activeFieldIndex];
  }

  setFieldLoader(loaderFn) {
    this.fieldLoader = loaderFn;
  }

  setVarFieldLoader(loaderFn) {
    this.varFieldLoader = loaderFn;
  }

  initVarData(varManifest) {
    if (!varManifest) return;
    const normalizedFields = (varManifest?.fields || []).map((field) => ({
      ...field,
      loaded: Boolean(field?.values),
      _loadingPromise: null
    }));
    this.varData = { ...varManifest, fields: normalizedFields };
  }

  async ensureFieldLoaded(fieldIndex) {
    const field = this.obsData?.fields?.[fieldIndex];
    if (!field) throw new Error(`Obs field ${fieldIndex} is not available.`);
    const cacheKey = field.key || String(fieldIndex);
    if (field.loaded) {
      if (!this._fieldDataCache.has(cacheKey)) {
        this._fieldDataCache.set(cacheKey, {
          values: field.values,
          codes: field.codes,
          outlierQuantiles: field.outlierQuantiles
        });
      }
      return field;
    }
    if (field._loadingPromise) return field._loadingPromise;
    if (!this.fieldLoader) throw new Error(`No loader configured for field "${field.key}".`);

    const cached = this._fieldDataCache.get(cacheKey);
    if (cached) {
      if (cached.values) field.values = cached.values;
      if (cached.codes) field.codes = cached.codes;
      if (cached.outlierQuantiles) field.outlierQuantiles = cached.outlierQuantiles;
      field.loaded = true;
      return field;
    }

    field._loadingPromise = this.fieldLoader(field)
      .then((loadedData) => {
        if (loadedData?.values) field.values = loadedData.values;
        if (loadedData?.codes) field.codes = loadedData.codes;
        if (loadedData?.outlierQuantiles) field.outlierQuantiles = loadedData.outlierQuantiles;
        if (field.values && field.values.length !== this.pointCount) {
          throw new Error(`Field "${field.key}" values length mismatch (${field.values.length} vs ${this.pointCount}).`);
        }
        if (field.codes && field.codes.length !== this.pointCount) {
          throw new Error(`Field "${field.key}" codes length mismatch (${field.codes.length} vs ${this.pointCount}).`);
        }
        if (field.outlierQuantiles && field.outlierQuantiles.length !== this.pointCount) {
          throw new Error(`Field "${field.key}" outlier length mismatch (${field.outlierQuantiles.length} vs ${this.pointCount}).`);
        }
        field.loaded = true;
        field._loadingPromise = null;
        this._fieldDataCache.set(cacheKey, {
          values: field.values,
          codes: field.codes,
          outlierQuantiles: field.outlierQuantiles
        });
        return field;
      })
      .catch((err) => {
        field._loadingPromise = null;
        throw err;
      });

    return field._loadingPromise;
  }

  async ensureVarFieldLoaded(fieldIndex) {
    const field = this.varData?.fields?.[fieldIndex];
    if (!field) throw new Error(`Var field ${fieldIndex} is not available.`);
    const cacheKey = field.key || String(fieldIndex);
    if (field.loaded) {
      if (!this._varFieldDataCache.has(cacheKey)) {
        this._varFieldDataCache.set(cacheKey, { values: field.values });
      }
      return field;
    }
    if (field._loadingPromise) return field._loadingPromise;
    if (!this.varFieldLoader) throw new Error(`No loader configured for var field "${field.key}".`);

    const cached = this._varFieldDataCache.get(cacheKey);
    if (cached) {
      if (cached.values) field.values = cached.values;
      field.loaded = true;
      return field;
    }

    field._loadingPromise = this.varFieldLoader(field)
      .then((loadedData) => {
        if (loadedData?.values) field.values = loadedData.values;
        if (field.values && field.values.length !== this.pointCount) {
          throw new Error(`Var field "${field.key}" values length mismatch (${field.values.length} vs ${this.pointCount}).`);
        }
        field.loaded = true;
        field._loadingPromise = null;
        this._varFieldDataCache.set(cacheKey, { values: field.values });
        return field;
      })
      .catch((err) => {
        field._loadingPromise = null;
        throw err;
      });

    return field._loadingPromise;
  }

  setActiveField(fieldIndex) {
    if (!this.obsData || !this.obsData.fields || !this.obsData.fields[fieldIndex]) return null;
    this.activeFieldIndex = fieldIndex;
    this.activeVarFieldIndex = -1;
    this.activeFieldSource = 'obs';
    const field = this.obsData.fields[fieldIndex];
    if (!field.loaded) {
      throw new Error(`Field "${field.key}" not loaded yet.`);
    }

    if (field.kind === 'continuous') {
      this.updateColorsContinuous(field, { resetTransparency: true });
      this.clearCentroids();
    } else {
      this.updateColorsCategorical(field);
      this.buildCentroidsForField(field);
    }

    if (field.outlierQuantiles && field.outlierQuantiles.length > 0) {
      if (field._outlierThreshold == null) field._outlierThreshold = 1.0;
    }

    this.updateOutlierQuantiles();
    this._pushColorsToViewer();
    this._pushTransparencyToViewer();
    this._pushCentroidsToViewer();
    this._pushOutlierThresholdToViewer(this.getCurrentOutlierThreshold());
    this.computeGlobalVisibility();
    this._syncActiveContext();

    const centroidInfo =
      field.kind === 'category' && field.centroids ? ` • Centroids: ${field.centroids.length}` : '';
    return {
      field,
      pointCount: this.pointCount,
      centroidInfo
    };
  }

  setActiveVarField(fieldIndex) {
    if (!this.varData || !this.varData.fields || !this.varData.fields[fieldIndex]) return null;
    this.activeVarFieldIndex = fieldIndex;
    this.activeFieldIndex = -1;
    this.activeFieldSource = 'var';
    const field = this.varData.fields[fieldIndex];
    if (!field.loaded) {
      throw new Error(`Var field "${field.key}" not loaded yet.`);
    }

    // Gene expression is always continuous
    this.updateColorsContinuous(field, { resetTransparency: true });
    this.clearCentroids();

    this.updateOutlierQuantiles();
    this._pushColorsToViewer();
    this._pushTransparencyToViewer();
    this._pushCentroidsToViewer();
    this._pushOutlierThresholdToViewer(1.0);
    this.computeGlobalVisibility();
    this._syncActiveContext();

    return {
      field,
      pointCount: this.pointCount,
      centroidInfo: ''
    };
  }

  getContinuousFieldRef(fieldIndex) {
    if (this.activeFieldSource === 'var' && this.activeVarFieldIndex >= 0) {
      const field = this.varData?.fields?.[this.activeVarFieldIndex];
      return { field, source: 'var', index: this.activeVarFieldIndex };
    }
    const idx = fieldIndex != null ? fieldIndex : this.activeFieldIndex;
    if (idx == null || idx < 0) return { field: null, source: null, index: -1 };
    const field = this.obsData?.fields?.[idx];
    return { field, source: 'obs', index: idx };
  }

  updateOutlierQuantiles() {
    if (!this.pointCount || !this.obsData || !this.obsData.fields) return;

    if (!this.outlierQuantilesArray || this.outlierQuantilesArray.length !== this.pointCount) {
      this.outlierQuantilesArray = new Float32Array(this.pointCount);
    }
    this.outlierQuantilesArray.fill(-1.0);

    const fields = this.obsData.fields;
    for (let f = 0; f < fields.length; f++) {
      const field = fields[f];
      if (!field || !field.outlierQuantiles || !field.outlierQuantiles.length) continue;
      
      // Check if outlier filter is enabled
      const outlierFilterEnabled = field._outlierFilterEnabled !== false;
      if (!outlierFilterEnabled) continue;
      
      const rawThreshold = field._outlierThreshold != null ? field._outlierThreshold : 1.0;
      if (rawThreshold >= 0.9999) continue;

      const threshold = Math.max(rawThreshold, 0.001);
      const qList = field.outlierQuantiles;
      for (let i = 0; i < this.pointCount; i++) {
        const q = qList[i];
        if (q === null || q === undefined || Number.isNaN(q)) continue;
        if (q > rawThreshold) {
          const ratio = q / threshold;
          if (this.outlierQuantilesArray[i] < 0 || ratio > this.outlierQuantilesArray[i]) {
            this.outlierQuantilesArray[i] = ratio;
          }
        }
      }
    }

    this._pushOutliersToViewer();
    this._syncActiveContext();
    this.updateFilteredCount();
    this.updateFilterSummary();
    this._notifyVisibilityChange();
  }

  updateFilteredCount() {
    if (!this.pointCount) {
      this.filteredCount = { shown: 0, total: 0 };
      return;
    }
    const total = this.pointCount;
    const threshold = this.getCurrentOutlierThreshold();
    const outliers = this.outlierQuantilesArray || [];
    const alpha = this.categoryTransparency || [];
    let shown = 0;
    for (let i = 0; i < total; i++) {
      const visible = (alpha[i] ?? 0) > 0.001;
      if (!visible) continue;
      const q = outliers[i] ?? -1;
      if (q >= 0 && q > threshold) continue;
      shown++;
    }
    this.filteredCount = { shown, total };
  }

  getFilteredCount() {
    return this.filteredCount || { shown: this.pointCount, total: this.pointCount };
  }

  computeCategoryCountsForField(field) {
    if (!field || field.kind !== 'category') return null;
    const categories = field.categories || [];
    const codes = field.codes || [];
    const total = new Array(categories.length).fill(0);
    const available = new Array(categories.length).fill(0); // respects other filters, ignores this field's category visibility
    const visible = new Array(categories.length).fill(0); // respects all filters including this field's category visibility
    const alpha = this.categoryTransparency || [];
    const outliers = this.outlierQuantilesArray || [];
    const threshold = this.getCurrentOutlierThreshold();
    const n = Math.min(this.pointCount, codes.length);
    const fields = this.obsData?.fields || [];
    const targetIndex = fields.indexOf(field);
    const activeVarField =
      this.activeFieldSource === 'var' && this.activeVarFieldIndex >= 0
        ? this.varData?.fields?.[this.activeVarFieldIndex]
        : null;
    const activeVarValues = activeVarField?.values || [];

    for (let i = 0; i < n; i++) {
      const code = codes[i];
      if (code == null || code < 0 || code >= categories.length) continue;
      total[code]++;

      // Compute visibility from other filters (but ignoring this field's own category visibility)
      let baseVisible = true;
      for (let f = 0; f < fields.length; f++) {
        const fField = fields[f];
        if (!fField) continue;
        if (fField === field) {
          // Ignore this field's category visibility for "available" counts
          continue;
        }
        if (fField.kind === 'category' && fField._categoryVisible) {
          const categoryFilterEnabled = fField._categoryFilterEnabled !== false;
          if (categoryFilterEnabled) {
            const codesOther = fField.codes || [];
            const catsOther = fField.categories || [];
            const numCatsOther = catsOther.length;
            const cCode = codesOther[i];
            if (cCode != null && cCode >= 0 && cCode < numCatsOther) {
              const isVis = fField._categoryVisible[cCode] !== false;
              if (!isVis) { baseVisible = false; break; }
            }
          }
        } else if (
          fField.kind === 'continuous' &&
          fField._continuousStats &&
          fField._continuousFilter
        ) {
          const filterEnabled = fField._filterEnabled !== false;
          if (filterEnabled) {
            const stats = fField._continuousStats;
            const filter = fField._continuousFilter;
            const values = fField.values || [];
            const fullRange =
              filter.min <= stats.min + 1e-6 &&
              filter.max >= stats.max - 1e-6;
            if (!fullRange) {
              const v = values[i];
              if (v === null || Number.isNaN(v) || v < filter.min || v > filter.max) {
                baseVisible = false;
                break;
              }
            }
          }
        }
      }
      if (baseVisible && activeVarField && activeVarField.kind === 'continuous') {
        const filterEnabled = activeVarField._filterEnabled !== false;
        if (filterEnabled && activeVarField._continuousStats && activeVarField._continuousFilter) {
          const stats = activeVarField._continuousStats;
          const filter = activeVarField._continuousFilter;
          const fullRange =
            filter.min <= stats.min + 1e-6 &&
            filter.max >= stats.max - 1e-6;
          if (!fullRange) {
            const v = activeVarValues[i];
            if (v === null || Number.isNaN(v) || v < filter.min || v > filter.max) {
              baseVisible = false;
            }
          }
        }
      }
      if (baseVisible) {
        const q = outliers[i] ?? -1;
        if (q >= 0 && q > threshold) {
          baseVisible = false;
        }
      }
      if (baseVisible) available[code]++;

      // Current visibility already encoded in alpha + outliers
      const isVisibleNow = (alpha[i] ?? 0) > 0.001;
      if (!isVisibleNow) continue;
      const qNow = outliers[i] ?? -1;
      if (qNow >= 0 && qNow > threshold) continue;
      visible[code]++;
    }
    const visibleTotal = visible.reduce((sum, v) => sum + v, 0);
    const availableTotal = available.reduce((sum, v) => sum + v, 0);
    return { total, available, availableTotal, visible, visibleTotal };
  }

  _computeCountsForContinuous(field, source, { ignoreSelfFilter = false } = {}) {
    if (!field || field.kind !== 'continuous') return null;
    const n = this.pointCount || 0;
    if (!n) return { available: 0, visible: 0 };
    const obsFields = this.obsData?.fields || [];
    const activeVarField =
      this.activeFieldSource === 'var' && this.activeVarFieldIndex >= 0
        ? this.varData?.fields?.[this.activeVarFieldIndex]
        : null;
    const activeVarValues = activeVarField?.values || [];
    const targetValues = field.values || [];
    const outliers = this.outlierQuantilesArray || [];
    const threshold = this.getCurrentOutlierThreshold();
    let available = 0;
    let visible = 0;

    for (let i = 0; i < n; i++) {
      let passes = true;

      for (let f = 0; f < obsFields.length; f++) {
        const obsField = obsFields[f];
        if (!obsField) continue;
        if (obsField.kind === 'category' && obsField._categoryVisible) {
          const categoryFilterEnabled = obsField._categoryFilterEnabled !== false;
          if (categoryFilterEnabled) {
            const codes = obsField.codes || [];
            const categories = obsField.categories || [];
            const numCats = categories.length;
            const code = codes[i];
            if (code != null && code >= 0 && code < numCats) {
              const isVisible = obsField._categoryVisible[code] !== false;
              if (!isVisible) { passes = false; break; }
            }
          }
        } else if (obsField.kind === 'continuous' && obsField._continuousStats && obsField._continuousFilter) {
          const filterEnabled = obsField._filterEnabled !== false;
          const isSelf = source === 'obs' && obsField === field;
          if (filterEnabled && !(isSelf && ignoreSelfFilter)) {
            const stats = obsField._continuousStats;
            const filter = obsField._continuousFilter;
            const values = obsField.values || [];
            const fullRange =
              filter.min <= stats.min + 1e-6 &&
              filter.max >= stats.max - 1e-6;
            if (!fullRange) {
              const v = values[i];
              if (v === null || Number.isNaN(v) || v < filter.min || v > filter.max) {
                passes = false;
                break;
              }
            }
          }
        }
      }
      if (!passes) continue;

      if (activeVarField && activeVarField.kind === 'continuous' && activeVarField._continuousStats && activeVarField._continuousFilter) {
        const filterEnabled = activeVarField._filterEnabled !== false;
        const isSelfVar = source === 'var' && activeVarField === field;
        if (filterEnabled && !(isSelfVar && ignoreSelfFilter)) {
          const stats = activeVarField._continuousStats;
          const filter = activeVarField._continuousFilter;
          const fullRange =
            filter.min <= stats.min + 1e-6 &&
            filter.max >= stats.max - 1e-6;
          if (!fullRange) {
            const v = activeVarValues[i];
            if (v === null || Number.isNaN(v) || v < filter.min || v > filter.max) {
              passes = false;
            }
          }
        }
      }
      if (!passes) continue;

      // Outliers always apply (they are a separate filter type)
      const q = outliers[i] ?? -1;
      if (q >= 0 && q > threshold) continue;

      available++;

      // Apply self filter if it was skipped in the pass phase
      if (ignoreSelfFilter) {
        if (field._filterEnabled === false || !field._continuousStats || !field._continuousFilter) {
          visible++;
          continue;
        }
        const stats = field._continuousStats;
        const filter = field._continuousFilter;
        const fullRange =
          filter.min <= stats.min + 1e-6 &&
          filter.max >= stats.max - 1e-6;
        if (!fullRange) {
          const v = targetValues[i];
          if (v === null || Number.isNaN(v) || v < filter.min || v > filter.max) {
            continue;
          }
        }
      }
      visible++;
    }
    return { available, visible };
  }

  getFilterCellCounts(filter) {
    if (!filter) return null;
    if (filter.type === 'category') {
      const field =
        filter.source === 'var'
          ? this.varData?.fields?.[filter.fieldIndex]
          : this.obsData?.fields?.[filter.fieldIndex];
      const counts = field?._categoryCounts;
      if (counts) {
        return {
          available: counts.availableTotal ?? counts.available?.reduce((s, v) => s + v, 0) ?? 0,
          visible: counts.visibleTotal ?? counts.visible?.reduce((s, v) => s + v, 0) ?? 0
        };
      }
      return null;
    }
    if (filter.type === 'continuous') {
      const field =
        filter.source === 'var'
          ? this.varData?.fields?.[filter.fieldIndex]
          : this.obsData?.fields?.[filter.fieldIndex];
      if (!field) return null;
      return this._computeCountsForContinuous(field, filter.source, { ignoreSelfFilter: true });
    }
    return null;
  }

  _applyCategoryCountsToCentroids(field, counts) {
    if (!field || field.kind !== 'category') return false;
    if (!field.centroids || !this.centroidColors) return false;
    const categories = field.categories || [];
    const visibleCounts = counts?.visible || [];
    const catIndexByName = new Map();
    categories.forEach((cat, idx) => catIndexByName.set(String(cat), idx));
    let changed = false;
    for (let i = 0; i < field.centroids.length; i++) {
      const c = field.centroids[i];
      const idx = catIndexByName.get(String(c.category));
      const count = idx != null ? (visibleCounts[idx] || 0) : 0;
      const alpha = count > 0 ? 255 : 0; // uint8 alpha
      const alphaIdx = i * 4 + 3; // alpha is 4th component in RGBA
      if (this.centroidColors[alphaIdx] !== alpha) {
        this.centroidColors[alphaIdx] = alpha;
        changed = true;
      }
      if (this.centroidLabels[i]) {
        this.centroidLabels[i].alpha = alpha / 255; // keep float for label logic
      }
      if (this.centroidLabels[i]?.el) {
        const shouldShow = alpha > 0;
        const prevShow = this.centroidLabels[i].el.style.display !== 'none';
        if (prevShow !== shouldShow) {
          this.centroidLabels[i].el.style.display = shouldShow ? 'block' : 'none';
          changed = true;
        }
      }
    }
    return changed;
  }

  _updateActiveCategoryCounts() {
    const field = this.getActiveField();
    if (!field || field.kind !== 'category') {
      this._activeCategoryCounts = null;
      return false;
    }
    const counts = this.computeCategoryCountsForField(field);
    field._categoryCounts = counts;
    this._activeCategoryCounts = counts;
    return this._applyCategoryCountsToCentroids(field, counts);
  }

  ensureContinuousMetadata(field) {
    if (!field || field.kind !== 'continuous') return null;
    const needsStats = !field._continuousStats
      || !isFinite(field._continuousStats.min)
      || !isFinite(field._continuousStats.max);
    if (needsStats) {
      const values = field.values || [];
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v === null || Number.isNaN(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (!isFinite(min) || !isFinite(max)) {
        min = 0; max = 1;
      }
      if (max === min) max = min + 1;
      if (!field._continuousStats) field._continuousStats = { min, max };
      else {
        field._continuousStats.min = min;
        field._continuousStats.max = max;
      }
    }
    if (!field._continuousFilter) {
      field._continuousFilter = {
        min: field._continuousStats.min,
        max: field._continuousStats.max
      };
    } else {
      field._continuousFilter.min = Math.max(
        field._continuousStats.min,
        Math.min(field._continuousFilter.min, field._continuousStats.max)
      );
      field._continuousFilter.max = Math.max(
        field._continuousStats.min,
        Math.min(field._continuousFilter.max, field._continuousStats.max)
      );
      if (field._continuousFilter.min > field._continuousFilter.max) {
        field._continuousFilter.min = field._continuousStats.min;
        field._continuousFilter.max = field._continuousStats.max;
      }
    }
    if (field._useFilterColorRange == null) field._useFilterColorRange = true;
    if (!field._continuousColorRange) {
      field._continuousColorRange = {
        min: field._continuousFilter.min,
        max: field._continuousFilter.max
      };
    } else {
      field._continuousColorRange.min = Math.max(
        field._continuousStats.min,
        Math.min(field._continuousColorRange.min, field._continuousStats.max)
      );
      field._continuousColorRange.max = Math.max(
        field._continuousStats.min,
        Math.min(field._continuousColorRange.max, field._continuousStats.max)
      );
      if (field._continuousColorRange.min > field._continuousColorRange.max) {
        field._continuousColorRange.min = field._continuousStats.min;
        field._continuousColorRange.max = field._continuousStats.max;
      }
    }
    const needsPositiveStats = !field._positiveStats
      || !isFinite(field._positiveStats.min)
      || !isFinite(field._positiveStats.max);
    if (needsPositiveStats) {
      const values = field.values || [];
      let minPos = Infinity;
      let maxPos = -Infinity;
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v === null || Number.isNaN(v) || v <= 0) continue;
        if (v < minPos) minPos = v;
        if (v > maxPos) maxPos = v;
      }
      field._positiveStats = (minPos !== Infinity && maxPos !== -Infinity)
        ? { min: minPos, max: maxPos }
        : null;
    }
    if (field._useLogScale == null) field._useLogScale = false;
    const colormap = getColormap(field._colormapId);
    field._colormapId = colormap.id;
    return {
      stats: field._continuousStats,
      filter: field._continuousFilter,
      colorRange: field._continuousColorRange,
      positiveStats: field._positiveStats
    };
  }

  getContinuousColorDomain(field) {
    if (!field || field.kind !== 'continuous') {
      return { min: 0, max: 1, scale: 'linear', usingFilter: false };
    }
    const meta = this.ensureContinuousMetadata(field);
    if (!meta) return { min: 0, max: 1, scale: 'linear', usingFilter: false };
    const stats = meta.stats;
    const useFilterRange = field._useFilterColorRange === true;
    const baseDomain = useFilterRange ? meta.colorRange : stats;
    const requestedLog = field._useLogScale === true;

    let domainMin = baseDomain?.min ?? stats.min;
    let domainMax = baseDomain?.max ?? stats.max;
    let scale = requestedLog ? 'log' : 'linear';

    if (scale === 'log') {
      const pos = meta.positiveStats;
      if (pos && pos.min > 0 && pos.max > 0) {
        domainMin = Math.max(domainMin, pos.min);
        domainMax = Math.min(domainMax, pos.max);
        if (!isFinite(domainMin) || domainMin <= 0) domainMin = pos.min;
        if (!isFinite(domainMax) || domainMax <= 0) domainMax = pos.max;
        if (domainMax <= domainMin) {
          domainMin = pos.min;
          domainMax = pos.max;
        }
      } else {
        // No positive values to drive a log scale; fall back to a safe dummy range
        domainMin = 1;
        domainMax = 10;
      }
    }

    if (!isFinite(domainMin) || !isFinite(domainMax)) {
      domainMin = stats.min;
      domainMax = stats.max;
    }

    if (scale === 'log') {
      if (domainMin <= 0) domainMin = Math.max(domainMax / 10, 1e-6);
      if (domainMax <= domainMin) domainMax = domainMin * 10;
    } else if (domainMax === domainMin) {
      domainMax = domainMin + 1;
    }

    return {
      min: domainMin,
      max: domainMax,
      scale,
      usingFilter: useFilterRange
    };
  }

  updateColorsContinuous(field, { resetTransparency = false } = {}) {
    if (!field || field.kind !== 'continuous') return;
    const meta = this.ensureContinuousMetadata(field);
    const domain = this.getContinuousColorDomain(field);
    const colormap = getColormap(field._colormapId);
    const useLog = domain.scale === 'log';
    let domainMin = domain.min;
    let domainMax = domain.max;
    if (!isFinite(domainMin) || !isFinite(domainMax) || domainMin === domainMax) {
      domainMin = meta?.stats?.min ?? 0;
      domainMax = meta?.stats?.max ?? (domainMin + 1);
      if (domainMax === domainMin) domainMax = domainMin + 1;
    }
    const logMin = useLog ? Math.log10(domainMin) : 0;
    const denom = useLog ? (Math.log10(domainMax) - logMin) : (domainMax - domainMin);
    const range = denom || 1;
    const values = field.values || [];
    const n = this.pointCount;

    if (!this.categoryTransparency || this.categoryTransparency.length !== n) {
      this.categoryTransparency = new Float32Array(n);
    }
    if (resetTransparency) {
      this.categoryTransparency.fill(1.0);
    }

    for (let i = 0; i < n; i++) {
      const v = values[i];
      let r, g, b;
      if (v === null || Number.isNaN(v) || (useLog && v <= 0)) {
        r = NEUTRAL_GRAY_UINT8; g = NEUTRAL_GRAY_UINT8; b = NEUTRAL_GRAY_UINT8;
      } else {
        let t;
        if (useLog) {
          t = (Math.log10(v) - logMin) / range;
        } else {
          t = (v - domainMin) / range;
        }
        const c = sampleContinuousColormap(colormap.id, t);
        // Convert from 0-1 float to 0-255 uint8
        r = Math.round(c[0] * 255);
        g = Math.round(c[1] * 255);
        b = Math.round(c[2] * 255);
      }
      const j = i * 4;
      this.colorsArray[j] = r;
      this.colorsArray[j + 1] = g;
      this.colorsArray[j + 2] = b;
      // Alpha will be synced from categoryTransparency in syncColorsAlpha
    }
    this._syncColorsAlpha();
  }

  // Sync alpha from categoryTransparency to packed RGBA colorsArray
  _syncColorsAlpha() {
    const n = this.pointCount;
    const alpha = this.categoryTransparency;
    for (let i = 0; i < n; i++) {
      this.colorsArray[i * 4 + 3] = Math.round((alpha[i] ?? 1.0) * 255);
    }
  }

  ensureCategoryMetadata(field) {
    const categories = field.categories || [];
    const numCats = categories.length;
    if (!field._categoryColors) {
      const catColors = new Array(numCats);
      for (let i = 0; i < numCats; i++) {
        catColors[i] = getCategoryColor(i);
      }
      field._categoryColors = catColors;
    } else {
      for (let i = 0; i < numCats; i++) {
        const color = field._categoryColors[i];
        if (!color || color.length !== 3) {
          field._categoryColors[i] = getCategoryColor(i);
        }
      }
    }
    if (!field._categoryVisible) {
      field._categoryVisible = {};
      for (let i = 0; i < numCats; i++) {
        field._categoryVisible[i] = true;
      }
    }
  }

  updateColorsCategorical(field) {
    const n = this.pointCount;
    const categories = field.categories || [];
    const codes = field.codes || [];
    const numCats = categories.length;

    this.ensureCategoryMetadata(field);
    const catColors = field._categoryColors;
    const catVisible = field._categoryVisible;

    if (!this.categoryTransparency || this.categoryTransparency.length !== n) {
      this.categoryTransparency = new Float32Array(n);
    }

    for (let i = 0; i < n; i++) {
      const code = codes[i];
      let r, g, b, alpha;
      if (code == null || code < 0 || code >= numCats) {
        r = NEUTRAL_GRAY_UINT8; g = NEUTRAL_GRAY_UINT8; b = NEUTRAL_GRAY_UINT8;
        alpha = 1.0;
      } else {
        const isVisible = catVisible[code] !== false;
        const c = catColors[code] || getCategoryColor(code) || [0.5, 0.5, 0.5];
        if (!isVisible) {
          r = g = b = 128; // gray in uint8
          alpha = 0.0;
        } else {
          // Convert from 0-1 float to 0-255 uint8
          r = Math.round(c[0] * 255);
          g = Math.round(c[1] * 255);
          b = Math.round(c[2] * 255);
          alpha = 1.0;
        }
      }
      const j = i * 4;
      this.colorsArray[j] = r;
      this.colorsArray[j + 1] = g;
      this.colorsArray[j + 2] = b;
      this.colorsArray[j + 3] = Math.round(alpha * 255);
      this.categoryTransparency[i] = alpha;
    }
    this._pushTransparencyToViewer();
    this._syncActiveContext();
  }

  clearCentroids() {
    this.centroidCount = 0;
    this.centroidPositions = null;
    this.centroidColors = null; // RGBA uint8
    this.centroidOutliers = null;
    this.centroidLabels = [];
    this._removeLabelsForView(this.activeViewId);
    if (this.viewer && typeof this.viewer.setCentroidLabels === 'function') {
      this.viewer.setCentroidLabels([], this.activeViewId);
    }
    this._pushCentroidsToViewer();
    this._syncActiveContext();
  }

  buildCentroidsForField(field) {
    const centroids = field.centroids || [];
    const categories = field.categories || [];
    this.ensureCategoryMetadata(field);
    const catColors = field._categoryColors || [];
    const viewKey = String(this.activeViewId || 'live');
    this.centroidCount = centroids.length;
    const allowLabels = true;

    this.centroidPositions = new Float32Array(this.centroidCount * 3);
    this.centroidColors = new Uint8Array(this.centroidCount * 4); // RGBA uint8
    this.centroidOutliers = new Float32Array(this.centroidCount);
    this.centroidOutliers.fill(-1.0);

    this.centroidLabels = [];
    if (allowLabels && this.labelLayer) this._removeLabelsForView(viewKey);

    const catIndexByName = new Map();
    categories.forEach((cat, idx) => catIndexByName.set(String(cat), idx));

    // Pre-compute counts so centroids/labels respect visibility immediately
    const counts = this.computeCategoryCountsForField(field);
    if (counts) {
      field._categoryCounts = counts;
      this._activeCategoryCounts = counts;
    }

    for (let i = 0; i < centroids.length; i++) {
      const c = centroids[i];
      const pos = c.position || [0, 0, 0];
      this.centroidPositions[3 * i] = pos[0];
      this.centroidPositions[3 * i + 1] = pos[1];
      this.centroidPositions[3 * i + 2] = pos[2];

      const idx = catIndexByName.get(String(c.category));
      let color = [0, 0, 0];
      if (idx != null) {
        const fallback = getCategoryColor(idx) || [0, 0, 0];
        color = catColors[idx] || fallback;
      }
      // Convert float 0-1 to uint8 0-255, RGBA format
      const colBase = i * 4;
      this.centroidColors[colBase] = Math.round(color[0] * 255);
      this.centroidColors[colBase + 1] = Math.round(color[1] * 255);
      this.centroidColors[colBase + 2] = Math.round(color[2] * 255);
      this.centroidColors[colBase + 3] = 255; // full alpha

      if (allowLabels && this.labelLayer) {
        const el = document.createElement('div');
        el.className = 'centroid-label';
        el.dataset.viewId = viewKey;
        el.textContent = String(c.category);
        this.labelLayer.appendChild(el);
        this.centroidLabels.push({ el, position: [pos[0], pos[1], pos[2]] });
      }
    }
    if (typeof this.viewer.setCentroidLabels === 'function') {
      this.viewer.setCentroidLabels(this.centroidLabels, this.activeViewId);
    }
  }

  updateLegendState(field) {
    if (!field) return null;
    if (field.kind === 'continuous') {
      const meta = this.ensureContinuousMetadata(field);
      if (!meta) return null;
      const colorDomain = this.getContinuousColorDomain(field);
      const colorbarMin = colorDomain?.min ?? meta.stats.min;
      const colorbarMax = colorDomain?.max ?? meta.stats.max;
      const colormap = getColormap(field._colormapId);
      const colorStops = getCssStopsForColormap(colormap.id);
      return {
        kind: 'continuous',
        stats: meta.stats,
        filter: meta.filter,
        scale: colorDomain.scale,
        logEnabled: field._useLogScale === true,
        colorStops,
        colormap: {
          id: colormap.id,
          label: colormap.label
        },
        colorbar: {
          min: colorbarMin,
          max: colorbarMax,
          usingFilter: colorDomain.usingFilter,
          scale: colorDomain.scale
        }
      };
    }
    this.ensureCategoryMetadata(field);
    const counts = field._categoryCounts || null;
    return {
      kind: 'category',
      categories: field.categories || [],
      colors: field._categoryColors,
      visible: field._categoryVisible,
      picker: COLOR_PICKER_PALETTE,
      counts
    };
  }

  applyContinuousFilter(fieldIndex, newMin, newMax) {
    const { field } = this.getContinuousFieldRef(fieldIndex);
    if (!field || field.kind !== 'continuous') return;
    const meta = this.ensureContinuousMetadata(field);
    if (!meta) return;
    const stats = meta.stats;
    const clampedMin = Math.max(stats.min, Math.min(newMin, stats.max));
    const clampedMax = Math.max(stats.min, Math.min(newMax, stats.max));
    field._continuousFilter.min = Math.min(clampedMin, clampedMax);
    field._continuousFilter.max = Math.max(clampedMin, clampedMax);
    this.computeGlobalVisibility();
  }

  resetContinuousFilter(fieldIndex) {
    const { field } = this.getContinuousFieldRef(fieldIndex);
    if (!field || field.kind !== 'continuous') return;
    const meta = this.ensureContinuousMetadata(field);
    if (!meta) return;
    field._continuousFilter.min = meta.stats.min;
    field._continuousFilter.max = meta.stats.max;
    this.computeGlobalVisibility();
  }

  setContinuousColorRescale(fieldIndex, enabled) {
    const { field } = this.getContinuousFieldRef(fieldIndex);
    if (!field || field.kind !== 'continuous') return;
    this.ensureContinuousMetadata(field);
    field._useFilterColorRange = Boolean(enabled);
    this.updateColorsContinuous(field);
    this._pushColorsToViewer();
    this._syncActiveContext();
  }

  setContinuousColorRange(fieldIndex, min, max) {
    const { field } = this.getContinuousFieldRef(fieldIndex);
    if (!field || field.kind !== 'continuous') return;
    const meta = this.ensureContinuousMetadata(field);
    if (!meta) return;
    const clampedMin = Math.max(meta.stats.min, Math.min(min, meta.stats.max));
    const clampedMax = Math.max(meta.stats.min, Math.min(max, meta.stats.max));
    field._continuousColorRange = {
      min: Math.min(clampedMin, clampedMax),
      max: Math.max(clampedMin, clampedMax)
    };
    if (field._useFilterColorRange) {
      this.updateColorsContinuous(field);
      this._pushColorsToViewer();
      this._syncActiveContext();
    }
  }

  setContinuousLogScale(fieldIndex, enabled) {
    const { field } = this.getContinuousFieldRef(fieldIndex);
    if (!field || field.kind !== 'continuous') return;
    this.ensureContinuousMetadata(field);
    field._useLogScale = Boolean(enabled);
    this.updateColorsContinuous(field);
    this._pushColorsToViewer();
    this._syncActiveContext();
  }

  setContinuousColormap(fieldIndex, colormapId) {
    const { field } = this.getContinuousFieldRef(fieldIndex);
    if (!field || field.kind !== 'continuous') return;
    const colormap = getColormap(colormapId);
    this.ensureContinuousMetadata(field);
    field._colormapId = colormap.id;
    this.updateColorsContinuous(field);
    this._pushColorsToViewer();
    this._syncActiveContext();
  }

  getContinuousColormaps() {
    return CONTINUOUS_COLORMAPS;
  }

  setOutlierThresholdForActive(threshold) {
    const field = this.getActiveField();
    if (!field || !field.outlierQuantiles || !field.outlierQuantiles.length) return;
    field._outlierThreshold = threshold;
    this._pushOutlierThresholdToViewer(threshold);
    this.updateOutlierQuantiles();
    // Recompute visibility to apply the new threshold
    this.computeGlobalVisibility();
  }

  getCurrentOutlierThreshold() {
    const field = this.getActiveField();
    if (field && field._outlierThreshold != null) return field._outlierThreshold;
    return 1.0;
  }

  computeGlobalVisibility() {
    if (!this.obsData || !this.obsData.fields || !this.pointCount) return;
    const fields = this.obsData.fields;
    const activeVarField = (this.activeFieldSource === 'var' && this.activeVarFieldIndex >= 0)
      ? this.varData?.fields?.[this.activeVarFieldIndex]
      : null;
    const activeVarValues = activeVarField?.values || [];
    if (!this.categoryTransparency || this.categoryTransparency.length !== this.pointCount) {
      this.categoryTransparency = new Float32Array(this.pointCount);
    }

    for (let i = 0; i < this.pointCount; i++) {
      let visible = true;
      for (let f = 0; f < fields.length; f++) {
        const field = fields[f];
        if (!field) continue;
        if (field.kind === 'category' && field._categoryVisible) {
          // Check if category filter is enabled
          const categoryFilterEnabled = field._categoryFilterEnabled !== false;
          if (categoryFilterEnabled) {
            const codes = field.codes || [];
            const categories = field.categories || [];
            const numCats = categories.length;
            const code = codes[i];
            if (code == null || code < 0 || code >= numCats) {
            } else {
              const isVisible = field._categoryVisible[code] !== false;
              if (!isVisible) { visible = false; break; }
            }
          }
        } else if (field.kind === 'continuous' && field._continuousStats && field._continuousFilter) {
          // Check if continuous filter is enabled
          const filterEnabled = field._filterEnabled !== false;
          if (filterEnabled) {
            const stats = field._continuousStats;
            const filter = field._continuousFilter;
            const values = field.values || [];
            const fullRange =
              filter.min <= stats.min + 1e-6 &&
              filter.max >= stats.max - 1e-6;
            if (!fullRange) {
              const v = values[i];
              if (v === null || Number.isNaN(v) || v < filter.min || v > filter.max) {
                visible = false;
                break;
              }
            }
          }
        }
      }
      if (
        visible &&
        activeVarField &&
        activeVarField.kind === 'continuous' &&
        activeVarField._continuousStats &&
        activeVarField._continuousFilter
      ) {
        // Check if var field filter is enabled
        const filterEnabled = activeVarField._filterEnabled !== false;
        if (filterEnabled) {
          const stats = activeVarField._continuousStats;
          const filter = activeVarField._continuousFilter;
          const fullRange =
            filter.min <= stats.min + 1e-6 &&
            filter.max >= stats.max - 1e-6;
          if (!fullRange) {
            const v = activeVarValues[i];
            if (v === null || Number.isNaN(v) || v < filter.min || v > filter.max) {
              visible = false;
            }
          }
        }
      }
      // Apply outlier filter based on active field's threshold
      if (visible && this.outlierQuantilesArray && this.outlierQuantilesArray.length > i) {
        const q = this.outlierQuantilesArray[i];
        const outlierThreshold = this.getCurrentOutlierThreshold();
        if (q >= 0 && q > outlierThreshold) {
          visible = false;
        }
      }
      this.categoryTransparency[i] = visible ? 1.0 : 0.0;
    }
    this._syncColorsAlpha();
    const centroidsChanged = this._updateActiveCategoryCounts();
    this._pushTransparencyToViewer();
    if (centroidsChanged) this._pushCentroidsToViewer();
    this._syncActiveContext();
    this.updateFilteredCount();
    this.updateFilterSummary();
    this._notifyVisibilityChange();
  }

  updateFilterSummary() {
    const lines = this.getFilterSummaryLines();
    this.activeFilterLines = lines;
    this._pushActiveViewLabelToViewer(lines);
  }

  getFilterSummaryLines() {
    // Returns array of strings for backward compatibility
    const filters = this.getActiveFiltersStructured();
    if (filters.length === 0) return ['No filters active (showing all points).'];
    return filters.map(f => f.text);
  }

  getActiveFiltersStructured() {
    // Returns structured filter data with id, type, enabled state, and display text
    if (!this.obsData || !this.obsData.fields) return [];
    const fields = this.obsData.fields;
    const filters = [];
    
    for (let fi = 0; fi < fields.length; fi++) {
      const field = fields[fi];
      if (!field) continue;
      const key = field.key || `Field ${fi + 1}`;
      
      // Continuous field filter
      if (field.kind === 'continuous' && field._continuousStats && field._continuousFilter) {
        const stats = field._continuousStats;
        const filter = field._continuousFilter;
        const fullRange =
          filter.min <= stats.min + 1e-6 &&
          filter.max >= stats.max - 1e-6;
        if (!fullRange) {
          const enabled = field._filterEnabled !== false; // default true
          filters.push({
            id: `obs-continuous-${fi}`,
            type: 'continuous',
            source: 'obs',
            fieldIndex: fi,
            fieldKey: key,
            enabled: enabled,
            text: `${key}: ${filter.min.toFixed(2)} – ${filter.max.toFixed(2)}`
          });
        }
      }
      
      // Categorical field hidden categories
      if (field.kind === 'category') {
        const categories = field.categories || [];
        const visibleMap = field._categoryVisible || {};
        const hiddenNames = [];
        for (let i = 0; i < categories.length; i++) {
          const name = String(categories[i]);
          const isVisible = visibleMap[i] !== false;
          if (!isVisible) hiddenNames.push(name);
        }
        if (hiddenNames.length > 0) {
          const enabled = field._categoryFilterEnabled !== false; // default true
          const preview = hiddenNames.slice(0, 4).join(', ');
          const extra = hiddenNames.length > 4 ? ` +${hiddenNames.length - 4} more` : '';
          filters.push({
            id: `obs-category-${fi}`,
            type: 'category',
            source: 'obs',
            fieldIndex: fi,
            fieldKey: key,
            enabled: enabled,
            hiddenCount: hiddenNames.length,
            text: `${key}: hiding ${preview}${extra}`
          });
        }
        
        // Outlier filter
        if (field.outlierQuantiles && field.outlierQuantiles.length) {
          const threshold = field._outlierThreshold != null ? field._outlierThreshold : 1.0;
          if (threshold < 0.9999) {
            const enabled = field._outlierFilterEnabled !== false; // default true
            const pct = Math.round(threshold * 100);
            filters.push({
              id: `obs-outlier-${fi}`,
              type: 'outlier',
              source: 'obs',
              fieldIndex: fi,
              fieldKey: key,
              enabled: enabled,
              text: `${key}: outlier ≤ ${pct}%`
            });
          }
        }
      }
    }
    
    // Var field (gene expression) filter
    if (
      this.activeFieldSource === 'var' &&
      this.activeVarFieldIndex >= 0 &&
      this.varData &&
      this.varData.fields
    ) {
      const field = this.varData.fields[this.activeVarFieldIndex];
      if (field && field.kind === 'continuous' && field._continuousStats && field._continuousFilter) {
        const stats = field._continuousStats;
        const filter = field._continuousFilter;
        const fullRange =
          filter.min <= stats.min + 1e-6 &&
          filter.max >= stats.max - 1e-6;
        if (!fullRange) {
          const enabled = field._filterEnabled !== false; // default true
          filters.push({
            id: `var-continuous-${this.activeVarFieldIndex}`,
            type: 'continuous',
            source: 'var',
            fieldIndex: this.activeVarFieldIndex,
            fieldKey: field.key,
            enabled: enabled,
            text: `${field.key}: ${filter.min.toFixed(2)} – ${filter.max.toFixed(2)}`
          });
        }
      }
    }
    
    return filters;
  }

  toggleFilterEnabled(filterId, enabled) {
    // Toggle filter on/off without removing it
    const parts = filterId.split('-');
    const source = parts[0]; // 'obs' or 'var'
    const type = parts[1]; // 'continuous', 'category', or 'outlier'
    const fieldIndex = parseInt(parts[2], 10);
    
    let field = null;
    if (source === 'obs') {
      field = this.obsData?.fields?.[fieldIndex];
    } else if (source === 'var') {
      field = this.varData?.fields?.[fieldIndex];
    }
    if (!field) return;
    
    if (type === 'continuous') {
      field._filterEnabled = enabled;
    } else if (type === 'category') {
      field._categoryFilterEnabled = enabled;
    } else if (type === 'outlier') {
      field._outlierFilterEnabled = enabled;
      // Outlier filter affects the outlierQuantilesArray
      this.updateOutlierQuantiles();
    }
    
    this.computeGlobalVisibility();
    this.updateFilterSummary();
  }

  removeFilter(filterId) {
    // Remove filter completely (reset to full range or show all categories)
    const parts = filterId.split('-');
    const source = parts[0]; // 'obs' or 'var'
    const type = parts[1]; // 'continuous', 'category', or 'outlier'
    const fieldIndex = parseInt(parts[2], 10);
    
    let field = null;
    if (source === 'obs') {
      field = this.obsData?.fields?.[fieldIndex];
    } else if (source === 'var') {
      field = this.varData?.fields?.[fieldIndex];
    }
    if (!field) return;
    
    if (type === 'continuous') {
      // Reset to full range
      if (field._continuousStats && field._continuousFilter) {
        field._continuousFilter.min = field._continuousStats.min;
        field._continuousFilter.max = field._continuousStats.max;
      }
      field._filterEnabled = true;
    } else if (type === 'category') {
      // Show all categories
      const categories = field.categories || [];
      if (!field._categoryVisible) field._categoryVisible = {};
      for (let i = 0; i < categories.length; i++) {
        field._categoryVisible[i] = true;
      }
      field._categoryFilterEnabled = true;
      // Update colors to reflect all categories visible
      this.reapplyCategoryColors(field);
    } else if (type === 'outlier') {
      // Reset outlier threshold to 100%
      field._outlierThreshold = 1.0;
      field._outlierFilterEnabled = true;
      this.updateOutlierQuantiles();
    }
    
    this.computeGlobalVisibility();
    this.updateFilterSummary();
  }

  reapplyCategoryColors(field) {
    if (!field || field.kind !== 'category') return;
    const n = this.pointCount;
    const categories = field.categories || [];
    const codes = field.codes || [];
    const catColors = field._categoryColors || [];
    const catVisible = field._categoryVisible || {};
    const numCats = categories.length;
    if (!this.categoryTransparency) this.categoryTransparency = new Float32Array(this.pointCount);

    for (let i = 0; i < n; i++) {
      const code = codes[i];
      let r, g, b;
      if (code == null || code < 0 || code >= numCats) {
        r = NEUTRAL_GRAY_UINT8; g = NEUTRAL_GRAY_UINT8; b = NEUTRAL_GRAY_UINT8;
      } else {
        const isVisible = catVisible[code] !== false;
        const c = catColors[code] || getCategoryColor(code) || [0.5, 0.5, 0.5];
        if (!isVisible) {
          // Gray out hidden categories (visual indicator), but don't set transparency here
          r = g = b = 128; // gray in uint8
        } else {
          // Convert from 0-1 float to 0-255 uint8
          r = Math.round(c[0] * 255);
          g = Math.round(c[1] * 255);
          b = Math.round(c[2] * 255);
        }
      }
      const j = i * 4;
      this.colorsArray[j] = r;
      this.colorsArray[j + 1] = g;
      this.colorsArray[j + 2] = b;
    }
    this._syncColorsAlpha();
    this._pushColorsToViewer();
    // Let computeGlobalVisibility handle transparency/filtering
    this.computeGlobalVisibility();
  }

  getLegendModel(field) {
    return this.updateLegendState(field);
  }

  getFilterLines() {
    return this.activeFilterLines || [];
  }

  getColorPalette() {
    return COLOR_PICKER_PALETTE;
  }

  getColorForCategory(field, idx) {
    this.ensureCategoryMetadata(field);
    const color = field._categoryColors[idx];
    if (color && color.length === 3) return color;
    const fallback = getCategoryColor(idx);
    if (!field._categoryColors[idx]) field._categoryColors[idx] = fallback;
    return fallback;
  }

  setColorForCategory(field, idx, color) {
    this.ensureCategoryMetadata(field);
    const fallback = getCategoryColor(idx);
    field._categoryColors[idx] = color || fallback;
    this.reapplyCategoryColors(field);
  }

  setVisibilityForCategory(field, idx, visible) {
    this.ensureCategoryMetadata(field);
    field._categoryVisible[idx] = visible;
    this.reapplyCategoryColors(field);
  }

  showAllCategories(field, { onlyAvailable = false } = {}) {
    this.ensureCategoryMetadata(field);
    const categories = field.categories || [];
    const available = onlyAvailable && field._categoryCounts ? field._categoryCounts.available : null;
    for (let i = 0; i < categories.length; i++) {
      if (available && (available[i] || 0) <= 0) continue;
      field._categoryVisible[i] = true;
    }
    this.reapplyCategoryColors(field);
  }

  hideAllCategories(field, { onlyAvailable = false } = {}) {
    this.ensureCategoryMetadata(field);
    const categories = field.categories || [];
    const available = onlyAvailable && field._categoryCounts ? field._categoryCounts.available : null;
    for (let i = 0; i < categories.length; i++) {
      if (available && (available[i] || 0) <= 0) continue;
      field._categoryVisible[i] = false;
    }
    this.reapplyCategoryColors(field);
  }

  rgbToCss(color) { return rgbToCss(color); }

  clearActiveField() {
    this.activeFieldIndex = -1;
    this.activeVarFieldIndex = -1;
    this.activeFieldSource = null;
    if (this.colorsArray) {
      // Fill with neutral gray (RGB) and full alpha
      for (let i = 0; i < this.pointCount; i++) {
        const idx = i * 4;
        this.colorsArray[idx] = NEUTRAL_GRAY_UINT8;
        this.colorsArray[idx + 1] = NEUTRAL_GRAY_UINT8;
        this.colorsArray[idx + 2] = NEUTRAL_GRAY_UINT8;
        this.colorsArray[idx + 3] = 255;
      }
    }
    if (!this.categoryTransparency || this.categoryTransparency.length !== this.pointCount) {
      this.categoryTransparency = new Float32Array(this.pointCount);
    }
    this.categoryTransparency.fill(1.0);
    if (this.outlierQuantilesArray) {
      this.outlierQuantilesArray.fill(-1.0);
      this._pushOutliersToViewer();
    }
    this._pushColorsToViewer();
    this._pushTransparencyToViewer();
    this._pushOutlierThresholdToViewer(1.0);
    this.clearCentroids();
    this.computeGlobalVisibility();
    this.updateFilterSummary();
    this._syncActiveContext();
    this._activeCategoryCounts = null;
    return {
      field: null,
      pointCount: this.pointCount,
      centroidInfo: ''
    };
  }

  // Snapshot payload for small multiples (Keep view)
  getSnapshotPayload() {
    const {
      label,
      fieldKey,
      fieldKind,
      filtersText
    } = this._computeActiveViewLabel();

    return {
      pointCount: this.pointCount,
      label,
      fieldKey,
      fieldKind,
      colors: this.colorsArray ? new Uint8Array(this.colorsArray) : null,
      transparency: this.categoryTransparency
        ? new Float32Array(this.categoryTransparency)
        : null,
      outlierQuantiles: this.outlierQuantilesArray
        ? new Float32Array(this.outlierQuantilesArray)
        : null,
      centroidPositions: this.centroidPositions
        ? new Float32Array(this.centroidPositions)
        : null,
      centroidColors: this.centroidColors
        ? new Uint8Array(this.centroidColors) // RGBA uint8
        : null,
      centroidOutliers: this.centroidOutliers
        ? new Float32Array(this.centroidOutliers)
        : null,
      outlierThreshold: this.getCurrentOutlierThreshold(),
      filtersText
    };
  }

  // --- Cell Highlighting/Selection API -------------------------------------------

  addHighlightChangeCallback(callback) {
    if (typeof callback === 'function') {
      this._highlightChangeCallbacks.add(callback);
    }
  }

  removeHighlightChangeCallback(callback) {
    this._highlightChangeCallbacks.delete(callback);
  }

  _notifyHighlightChange() {
    this._highlightChangeCallbacks.forEach((cb) => {
      try { cb(); }
      catch (err) { console.error('Highlight change callback failed', err); }
    });
  }

  // --- Highlight Page Management ---

  addHighlightPageChangeCallback(callback) {
    if (typeof callback === 'function') {
      this._highlightPageChangeCallbacks.add(callback);
    }
  }

  removeHighlightPageChangeCallback(callback) {
    this._highlightPageChangeCallbacks.delete(callback);
  }

  _notifyHighlightPageChange() {
    this._highlightPageChangeCallbacks.forEach((cb) => {
      try { cb(); }
      catch (err) { console.error('Highlight page change callback failed', err); }
    });
  }

  _getActivePage() {
    if (!this.activePageId) return null;
    return this.highlightPages.find((p) => p.id === this.activePageId) || null;
  }

  // Get highlighted groups for the active page (backwards compatible)
  get highlightedGroups() {
    const page = this._getActivePage();
    return page ? page.highlightedGroups : [];
  }

  // Set highlighted groups for the active page
  set highlightedGroups(groups) {
    const page = this._getActivePage();
    if (page) {
      page.highlightedGroups = groups;
    }
  }

  getHighlightPages() {
    return this.highlightPages;
  }

  getActivePageId() {
    return this.activePageId;
  }

  getActivePage() {
    return this._getActivePage();
  }

  createHighlightPage(name = null) {
    const id = `page_${++this._highlightPageIdCounter}`;
    const pageName = name || `Page ${this.highlightPages.length + 1}`;
    const page = {
      id,
      name: pageName,
      highlightedGroups: []
    };
    this.highlightPages.push(page);

    // If this is the first page, make it active
    if (this.highlightPages.length === 1) {
      this.activePageId = id;
    }

    this._notifyHighlightPageChange();
    return page;
  }

  switchToPage(pageId) {
    const page = this.highlightPages.find((p) => p.id === pageId);
    if (!page) return false;

    if (this.activePageId === pageId) return true;

    this.activePageId = pageId;
    this._recomputeHighlightArray();
    this._notifyHighlightChange();
    this._notifyHighlightPageChange();
    return true;
  }

  deleteHighlightPage(pageId) {
    const idx = this.highlightPages.findIndex((p) => p.id === pageId);
    if (idx === -1) return false;

    // Don't allow deleting the last page
    if (this.highlightPages.length <= 1) return false;

    this.highlightPages.splice(idx, 1);

    // If we deleted the active page, switch to another
    if (this.activePageId === pageId) {
      this.activePageId = this.highlightPages[0].id;
      this._recomputeHighlightArray();
      this._notifyHighlightChange();
    }

    this._notifyHighlightPageChange();
    return true;
  }

  renameHighlightPage(pageId, newName) {
    const page = this.highlightPages.find((p) => p.id === pageId);
    if (!page) return false;
    page.name = newName;
    this._notifyHighlightPageChange();
    return true;
  }

  /**
   * Combine two highlight pages using intersection or union
   * @param {string} pageId1 - First page ID
   * @param {string} pageId2 - Second page ID
   * @param {'intersection' | 'union'} operation - The set operation to perform
   * @returns {Object|null} The newly created page, or null if failed
   */
  combineHighlightPages(pageId1, pageId2, operation) {
    const page1 = this.highlightPages.find((p) => p.id === pageId1);
    const page2 = this.highlightPages.find((p) => p.id === pageId2);
    if (!page1 || !page2) return null;

    // Collect all highlighted cell indices from each page
    const getCellSet = (page) => {
      const cellSet = new Set();
      for (const group of page.highlightedGroups) {
        if (group.enabled === false) continue;
        if (group.cellIndices) {
          for (const idx of group.cellIndices) {
            cellSet.add(idx);
          }
        }
      }
      return cellSet;
    };

    const set1 = getCellSet(page1);
    const set2 = getCellSet(page2);

    let resultIndices;
    let operationSymbol;
    if (operation === 'intersection') {
      // Cells that are in BOTH pages
      resultIndices = [...set1].filter((idx) => set2.has(idx));
      operationSymbol = '∩';
    } else {
      // Union: cells that are in EITHER page
      resultIndices = [...new Set([...set1, ...set2])];
      operationSymbol = '∪';
    }

    // Create the new page with derived name
    const newName = `${page1.name} ${operationSymbol} ${page2.name}`;
    const newPage = this.createHighlightPage(newName);

    // Add a single combined group if there are results
    if (resultIndices.length > 0) {
      const groupId = `highlight_${++this._highlightIdCounter}`;
      const group = {
        id: groupId,
        type: 'combined',
        label: `${operation === 'intersection' ? 'Intersection' : 'Union'} of ${page1.name} & ${page2.name}`,
        cellIndices: resultIndices,
        cellCount: resultIndices.length,
        enabled: true
      };
      newPage.highlightedGroups.push(group);
    }

    this._notifyHighlightPageChange();
    return newPage;
  }

  // Ensure at least one page exists
  ensureHighlightPage() {
    if (this.highlightPages.length === 0) {
      this.createHighlightPage('Page 1');
    }
  }

  _ensureHighlightArray() {
    if (!this.highlightArray || this.highlightArray.length !== this.pointCount) {
      this.highlightArray = new Uint8Array(this.pointCount);
    }
  }

  _recomputeHighlightArray() {
    this._ensureHighlightArray();
    this.highlightArray.fill(0);
    for (const group of this.highlightedGroups) {
      // Skip disabled groups
      if (group.enabled === false) continue;
      const indices = group.cellIndices;
      if (!indices) continue;
      for (let i = 0; i < indices.length; i++) {
        const idx = indices[i];
        if (idx >= 0 && idx < this.pointCount) {
          this.highlightArray[idx] = 255;
        }
      }
    }
    this._pushHighlightToViewer();
  }

  _pushHighlightToViewer() {
    if (this.viewer && typeof this.viewer.updateHighlight === 'function') {
      this.viewer.updateHighlight(this.highlightArray);
    }
  }

  // Get cell indices for a categorical selection
  // Only includes cells that are currently visible (pass all active filters)
  getCellIndicesForCategory(fieldIndex, categoryIndex, source = 'obs') {
    const field = source === 'var'
      ? this.varData?.fields?.[fieldIndex]
      : this.obsData?.fields?.[fieldIndex];
    if (!field || field.kind !== 'category') return [];
    const codes = field.codes || [];
    const indices = [];
    for (let i = 0; i < codes.length; i++) {
      if (codes[i] === categoryIndex) {
        // Only include cells that are currently visible (not filtered out)
        const isVisible = !this.categoryTransparency || this.categoryTransparency[i] > 0;
        if (isVisible) {
          indices.push(i);
        }
      }
    }
    return indices;
  }

  // Get cell indices for a continuous range selection
  // Only includes cells that are currently visible (pass all active filters)
  getCellIndicesForRange(fieldIndex, minVal, maxVal, source = 'obs') {
    const field = source === 'var'
      ? this.varData?.fields?.[fieldIndex]
      : this.obsData?.fields?.[fieldIndex];
    if (!field || field.kind !== 'continuous') return [];
    const values = field.values || [];
    const indices = [];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v !== null && !Number.isNaN(v) && v >= minVal && v <= maxVal) {
        // Only include cells that are currently visible (not filtered out)
        const isVisible = !this.categoryTransparency || this.categoryTransparency[i] > 0;
        if (isVisible) {
          indices.push(i);
        }
      }
    }
    return indices;
  }

  // Set a preview highlight for a continuous range (shown during drag)
  // This temporarily shows what would be highlighted without committing it
  setPreviewHighlightForRange(fieldIndex, minVal, maxVal, source = 'obs') {
    const field = source === 'var'
      ? this.varData?.fields?.[fieldIndex]
      : this.obsData?.fields?.[fieldIndex];
    if (!field || field.kind !== 'continuous') {
      this.clearPreviewHighlight();
      return;
    }

    const cellIndices = this.getCellIndicesForRange(fieldIndex, minVal, maxVal, source);

    this._ensureHighlightArray();
    // Start with existing permanent highlights
    this.highlightArray.fill(0);
    for (const group of this.highlightedGroups) {
      const indices = group.cellIndices;
      if (!indices) continue;
      for (let i = 0; i < indices.length; i++) {
        const idx = indices[i];
        if (idx >= 0 && idx < this.pointCount) {
          this.highlightArray[idx] = 255;
        }
      }
    }
    // Add preview highlights on top
    for (let i = 0; i < cellIndices.length; i++) {
      const idx = cellIndices[i];
      if (idx >= 0 && idx < this.pointCount) {
        this.highlightArray[idx] = 255;
      }
    }
    this._pushHighlightToViewer();
  }

  // Clear preview highlight (restore to only permanent highlights)
  clearPreviewHighlight() {
    this._recomputeHighlightArray();
  }

  // Add a highlighted group from a categorical selection
  addHighlightFromCategory(fieldIndex, categoryIndex, source = 'obs') {
    const field = source === 'var'
      ? this.varData?.fields?.[fieldIndex]
      : this.obsData?.fields?.[fieldIndex];
    if (!field || field.kind !== 'category') return null;
    const categories = field.categories || [];
    const categoryName = categories[categoryIndex];
    if (categoryName === undefined) return null;

    const cellIndices = this.getCellIndicesForCategory(fieldIndex, categoryIndex, source);
    if (cellIndices.length === 0) return null;

    const id = `highlight_${++this._highlightIdCounter}`;
    const group = {
      id,
      type: 'category',
      label: `${field.key}: ${categoryName}`,
      fieldKey: field.key,
      fieldIndex,
      fieldSource: source,
      categoryIndex,
      categoryName,
      cellIndices,
      cellCount: cellIndices.length
    };

    this.highlightedGroups.push(group);
    this._recomputeHighlightArray();
    this._notifyHighlightChange();
    return group;
  }

  // Add a highlighted group from a continuous range selection
  addHighlightFromRange(fieldIndex, minVal, maxVal, source = 'obs') {
    const field = source === 'var'
      ? this.varData?.fields?.[fieldIndex]
      : this.obsData?.fields?.[fieldIndex];
    if (!field || field.kind !== 'continuous') return null;

    const cellIndices = this.getCellIndicesForRange(fieldIndex, minVal, maxVal, source);
    if (cellIndices.length === 0) return null;

    const id = `highlight_${++this._highlightIdCounter}`;
    const formatVal = (v) => {
      if (Math.abs(v) >= 1000 || (Math.abs(v) > 0 && Math.abs(v) < 0.01)) {
        return v.toExponential(2);
      }
      return v.toFixed(2);
    };
    const group = {
      id,
      type: 'range',
      label: `${field.key}: ${formatVal(minVal)} – ${formatVal(maxVal)}`,
      fieldKey: field.key,
      fieldIndex,
      fieldSource: source,
      rangeMin: minVal,
      rangeMax: maxVal,
      cellIndices,
      cellCount: cellIndices.length
    };

    this.highlightedGroups.push(group);
    this._recomputeHighlightArray();
    this._notifyHighlightChange();
    return group;
  }

  removeHighlightGroup(groupId) {
    const idx = this.highlightedGroups.findIndex((g) => g.id === groupId);
    if (idx === -1) return false;
    this.highlightedGroups.splice(idx, 1);
    this._recomputeHighlightArray();
    this._notifyHighlightChange();
    return true;
  }

  toggleHighlightEnabled(groupId, enabled) {
    const group = this.highlightedGroups.find((g) => g.id === groupId);
    if (!group) return false;
    group.enabled = enabled;
    this._recomputeHighlightArray();
    this._notifyHighlightChange();
    return true;
  }

  clearAllHighlights() {
    if (this.highlightedGroups.length === 0) return;
    this.highlightedGroups = [];
    this._recomputeHighlightArray();
    this._notifyHighlightChange();
  }

  getHighlightedGroups() {
    return this.highlightedGroups;
  }

  getHighlightedCellCount() {
    // Returns count of highlighted cells that are currently visible
    if (!this.highlightArray) return 0;
    let count = 0;
    for (let i = 0; i < this.highlightArray.length; i++) {
      if (this.highlightArray[i] > 0) {
        // Only count if visible (no transparency = visible, or transparency > 0)
        const isVisible = !this.categoryTransparency || this.categoryTransparency[i] > 0;
        if (isVisible) count++;
      }
    }
    return count;
  }

  getTotalHighlightedCellCount() {
    // Returns total count of all highlighted cells, including filtered-out ones
    if (!this.highlightArray) return 0;
    let count = 0;
    for (let i = 0; i < this.highlightArray.length; i++) {
      if (this.highlightArray[i] > 0) count++;
    }
    return count;
  }

  // Get the cell index at a screen position (requires viewer support)
  getCellAtScreenPosition(x, y) {
    if (this.viewer && typeof this.viewer.pickCellAtScreen === 'function') {
      return this.viewer.pickCellAtScreen(x, y);
    }
    return -1;
  }

  // Get category index for a cell
  getCategoryForCell(cellIndex, fieldIndex, source = 'obs') {
    const field = source === 'var'
      ? this.varData?.fields?.[fieldIndex]
      : this.obsData?.fields?.[fieldIndex];
    if (!field || field.kind !== 'category') return -1;
    const codes = field.codes || [];
    if (cellIndex < 0 || cellIndex >= codes.length) return -1;
    return codes[cellIndex];
  }

  // Get value for a cell in a continuous field
  getValueForCell(cellIndex, fieldIndex, source = 'obs') {
    const field = source === 'var'
      ? this.varData?.fields?.[fieldIndex]
      : this.obsData?.fields?.[fieldIndex];
    if (!field || field.kind !== 'continuous') return null;
    const values = field.values || [];
    if (cellIndex < 0 || cellIndex >= values.length) return null;
    return values[cellIndex];
  }

  // Get all highlighted cell indices (unique, merged from all groups)
  getAllHighlightedCellIndices() {
    const set = new Set();
    for (const group of this.highlightedGroups) {
      if (group.cellIndices) {
        for (const idx of group.cellIndices) {
          set.add(idx);
        }
      }
    }
    return Array.from(set);
  }
}
