// Data/state manager: loads obs data, computes colors/filters, and feeds buffers to the viewer.
import { LRUCache } from '../data/sparse-utils.js';
import {
  rgbToCss,
  COLOR_PICKER_PALETTE,
  CONTINUOUS_COLORMAPS,
  getCategoryColor,
  getColormap,
  getCssStopsForColormap,
  sampleContinuousColormap
} from '../data/palettes.js';
import { getNotificationCenter } from './notification-center.js';
import { RenameRegistry } from './registries/rename-registry.js';
import { DeleteRegistry } from './registries/delete-registry.js';
import { UserDefinedFieldsRegistry } from './registries/user-defined-fields.js';
import { StateValidator } from './utils/state-validator.js';
import { ChangeType, FieldKind, FieldSource } from './utils/field-constants.js';
import { getFieldRegistry } from './utils/field-registry.js';
import { makeUniqueLabel } from './utils/label-utils.js';
import { getPageColor } from './utils/page-colors.js';
import {
  buildDeleteToUnassignedTransform,
  buildMergeCategoriesTransform,
  applyCategoryIndexMapping,
  applyCategoryIndexMappingInPlace
} from './utils/categorical-ops.js';

const NEUTRAL_GRAY_UINT8 = 211; // lightgray default when no field is selected (0-255)

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
    // LRU caches for field data to prevent unbounded memory growth
    // Obs fields: max 50 (each ~10 bytes × pointCount)
    // Var fields: max 20 (gene expressions, each ~4 bytes × pointCount, typically larger access pattern)
    this._fieldDataCache = new LRUCache(50); // field.key -> loaded arrays (shared across views)
    this._varFieldDataCache = new LRUCache(20); // var.field.key -> loaded arrays

    // Multi-dimensional embedding support
    this.dimensionManager = null; // Set via setDimensionManager()
    this.activeDimensionLevel = 3; // Current dimension level for live view (1, 2, 3, or 4)
    this._dimensionChangeCallbacks = new Set();

    // Cell highlighting/selection state - multi-page system
    // Each page contains its own independent set of highlight groups
    this.highlightPages = []; // Array of { id, name, highlightedGroups: [] }
    this.activePageId = null; // Currently active page ID
    this._highlightPageIdCounter = 0;
    this.highlightArray = new Uint8Array(0); // Uint8Array per-point highlight intensity (0-255)
    this._highlightIdCounter = 0;
    this._highlightChangeCallbacks = new Set();
    this._highlightPageChangeCallbacks = new Set(); // Callbacks when pages change (add/remove/rename/switch)
    this._cachedHighlightCount = null; // Cached visible highlight count
    this._cachedTotalHighlightCount = null; // Cached total highlight count
    this._cachedHighlightLodLevel = null; // LOD level used for cached visible highlight count

    // Batch mode: suppresses expensive recomputations during bulk filter restoration
    this._batchMode = false;
    this._batchDepth = 0; // Track nested batch calls
    this._batchDirty = { visibility: false, colors: false, affectedFields: new Set() };

    // -----------------------------------------------------------------------
    // Field operations (rename / delete / user-defined categoricals)
    // -----------------------------------------------------------------------

    this._renameRegistry = new RenameRegistry();
    this._deleteRegistry = new DeleteRegistry();
    this._userDefinedFields = new UserDefinedFieldsRegistry();
    this._fieldChangeCallbacks = new Set();

    // Bind singleton registry for fast lookups.
    getFieldRegistry().bind(this);
  }

  // --- Batch mode for bulk operations -----------------------------------------

  /**
   * Enter batch mode to suppress expensive recomputations during bulk filter changes.
   * Call endBatch() when done to apply all changes in a single recompute.
   */
  beginBatch() {
    this._batchDepth++;
    if (this._batchDepth === 1) {
      this._batchMode = true;
      this._batchDirty = { visibility: false, colors: false, affectedFields: new Set() };
    }
  }

  /**
   * Exit batch mode and perform a single consolidated recomputation.
   * Reapplies colors for affected fields and recomputes global visibility once.
   */
  endBatch() {
    if (this._batchDepth <= 0) return;
    this._batchDepth--;
    if (this._batchDepth > 0) return; // Still nested, don't flush yet
    this._batchMode = false;

    // Reapply colors for all affected fields (handles color array updates)
    if (this._batchDirty.colors && this._batchDirty.affectedFields.size > 0) {
      for (const field of this._batchDirty.affectedFields) {
        if (field) this._reapplyCategoryColorsNoRecompute(field);
      }
    }

    // Single visibility recomputation after all filter changes
    if (this._batchDirty.visibility || this._batchDirty.colors) {
      this.computeGlobalVisibility();
    }

    this._batchDirty = { visibility: false, colors: false, affectedFields: new Set() };
  }

  // --- Multi-dimensional embedding methods -----------------------------------

  /**
   * Set the dimension manager instance
   * @param {DimensionManager} manager - The dimension manager
   */
  setDimensionManager(manager) {
    this.dimensionManager = manager;
    if (manager) {
      this.activeDimensionLevel = manager.getDefaultDimension();
    }
  }

  /**
   * Get dimension manager
   * @returns {DimensionManager|null}
   */
  getDimensionManager() {
    return this.dimensionManager;
  }

  /**
   * Get current dimension level for the active view
   * @returns {number} Dimension level (1, 2, 3, or 4)
   */
  getDimensionLevel() {
    return this.activeDimensionLevel;
  }

  /**
   * Get dimension level for a specific view
   * @param {string} viewId - View identifier
   * @returns {number} Dimension level (1, 2, 3, or 4)
   */
  getViewDimensionLevel(viewId) {
    const ctx = this.viewContexts.get(String(viewId));
    if (ctx && ctx.dimensionLevel !== undefined) {
      return ctx.dimensionLevel;
    }
    return this.dimensionManager?.getDefaultDimension() ?? 3;
  }

  /**
   * Set dimension level for the active view (or a specific view)
   * @param {number} level - Dimension level (1, 2, 3, or 4)
   * @param {Object} options - Options
   * @param {boolean} options.updateViewer - Whether to update viewer positions
   * @param {string} options.viewId - Specific view ID to update (defaults to active view)
   * @returns {Promise<void>}
   */
  async setDimensionLevel(level, { updateViewer = true, viewId = null } = {}) {
    if (!this.dimensionManager) {
      console.warn('[State] No dimension manager set');
      return;
    }

    if (!this.dimensionManager.hasDimension(level)) {
      console.warn(`[State] Dimension ${level}D not available`);
      return;
    }

    // Handle 4D error
    if (level === 4) {
      throw new Error('4D visualization is not yet implemented');
    }

    // Determine which view to update
    const targetViewId = viewId ?? this.activeViewId;
    const isActiveView = String(targetViewId) === String(this.activeViewId);

    // Get the view context
    const ctx = this.viewContexts.get(String(targetViewId));
    const previousLevel = isActiveView ? this.activeDimensionLevel : (ctx?.dimensionLevel ?? this.activeDimensionLevel);

    // Skip if no change
    if (previousLevel === level) {
      return;
    }

    // Update the view context's dimension level
    if (ctx) {
      ctx.dimensionLevel = level;
    }

    // Update dimension manager's per-view tracking
    this.dimensionManager.setViewDimension(targetViewId, level);

    // If this is the active view, also update activeDimensionLevel
    if (isActiveView) {
      this.activeDimensionLevel = level;
    }

    // Load positions for the new dimension
    if (updateViewer && this.viewer) {
      try {
        const positions3D = await this.dimensionManager.getPositions3D(level);

        // IMPORTANT: Use 'live' check, NOT isActiveView, to determine which buffer to update.
        // Snapshot views should ALWAYS update their snapshot buffers, even if "active" in UI.
        // Only the live view should update main positions.
        const isLiveView = String(targetViewId) === 'live';

        if (isLiveView) {
          // Live view: update main positions
          this._updateViewerPositions(positions3D);

          // Rebuild centroids for the new dimension
          // IMPORTANT: Temporarily set activeDimensionLevel so buildCentroidsForField uses correct dimension
          // Use try/finally to guarantee restoration even if an exception occurs
          const savedDimLevel = this.activeDimensionLevel;
          this.activeDimensionLevel = level;
          try {
            // Use getFieldForView to get live's field, NOT getActiveField which returns active view's field
            const liveField = this.getFieldForView('live');
            if (liveField && liveField.kind === 'category') {
              this._ensureUserDefinedCentroidsForDim(liveField, level);
              this.buildCentroidsForField(liveField, { viewId: 'live' });
              // Push directly to live view's centroid buffers (don't use _pushCentroidsToViewer
              // which checks activeViewId and might push to wrong view)
              if (this.viewer) {
                this.viewer.setCentroids({
                  positions: this.centroidPositions || new Float32Array(),
                  colors: this.centroidColors || new Uint8Array(),
                  outlierQuantiles: this.centroidOutliers || new Float32Array()
                });
                if (this.viewer.setCentroidLabels) {
                  this.viewer.setCentroidLabels(this.centroidLabels, 'live');
                }
              }
              // Save centroids to live view's context (consistent with snapshot handling)
              if (ctx) {
                ctx.centroidPositions = this.centroidPositions ? new Float32Array(this.centroidPositions) : null;
                ctx.centroidColors = this.centroidColors ? new Uint8Array(this.centroidColors) : null;
                ctx.centroidOutliers = this.centroidOutliers ? new Float32Array(this.centroidOutliers) : null;
                ctx.centroidLabels = this.centroidLabels ? this.centroidLabels.map(c => c ? { ...c } : c) : [];
              }
            }
          } finally {
            // Restore if live wasn't active (but keep if it was, which was already set above)
            if (!isActiveView) {
              this.activeDimensionLevel = savedDimLevel;
              // IMPORTANT: Restore active view's centroid state since buildCentroidsForField
              // overwrote it with live's data
              const activeCtx = this.viewContexts.get(String(this.activeViewId));
              if (activeCtx) {
                this.centroidPositions = activeCtx.centroidPositions ? new Float32Array(activeCtx.centroidPositions) : null;
                this.centroidColors = activeCtx.centroidColors ? new Uint8Array(activeCtx.centroidColors) : null;
                this.centroidOutliers = activeCtx.centroidOutliers ? new Float32Array(activeCtx.centroidOutliers) : null;
                this.centroidLabels = activeCtx.centroidLabels || [];
              }
            }
          }
        } else {
          // Snapshot view: update viewer's per-view position cache
          // The viewer will use this to update the snapshot buffer
          if (this.viewer.setViewPositions) {
            this.viewer.setViewPositions(targetViewId, positions3D);
          }

          // Rebuild centroids for this snapshot view using its new dimension
          // We need to temporarily set activeDimensionLevel for buildCentroidsForField
          // Use try/finally to guarantee restoration even if an exception occurs
          const savedDimLevel = this.activeDimensionLevel;
          this.activeDimensionLevel = level;
          try {
            // Get the field for this snapshot view from its context
            const snapshotField = this.getFieldForView(targetViewId);
            if (snapshotField && snapshotField.kind === 'category') {
              this._ensureUserDefinedCentroidsForDim(snapshotField, level);
              this.buildCentroidsForField(snapshotField, { viewId: targetViewId });
              // Update the snapshot's centroid data in viewer
              if (this.viewer.updateSnapshotAttributes) {
                this.viewer.updateSnapshotAttributes(targetViewId, {
                  centroidPositions: this.centroidPositions || new Float32Array(),
                  centroidColors: this.centroidColors || new Uint8Array(),
                  centroidOutliers: this.centroidOutliers || new Float32Array()
                });
              }
              // Update centroid labels for this view
              if (this.viewer.setCentroidLabels) {
                this.viewer.setCentroidLabels(this.centroidLabels, targetViewId);
              }
              // Also save centroids to the view's context
              if (ctx) {
                ctx.centroidPositions = this.centroidPositions ? new Float32Array(this.centroidPositions) : null;
                ctx.centroidColors = this.centroidColors ? new Uint8Array(this.centroidColors) : null;
                ctx.centroidOutliers = this.centroidOutliers ? new Float32Array(this.centroidOutliers) : null;
                ctx.centroidLabels = this.centroidLabels ? this.centroidLabels.map(c => c ? { ...c } : c) : [];
              }
            }
          } finally {
            // Restore activeDimensionLevel
            this.activeDimensionLevel = savedDimLevel;

            // IMPORTANT: If this snapshot is not the active view, restore active view's centroid state
            // since buildCentroidsForField overwrote it with snapshot's data
            if (!isActiveView) {
              const activeCtx = this.viewContexts.get(String(this.activeViewId));
              if (activeCtx) {
                this.centroidPositions = activeCtx.centroidPositions ? new Float32Array(activeCtx.centroidPositions) : null;
                this.centroidColors = activeCtx.centroidColors ? new Uint8Array(activeCtx.centroidColors) : null;
                this.centroidOutliers = activeCtx.centroidOutliers ? new Float32Array(activeCtx.centroidOutliers) : null;
                this.centroidLabels = activeCtx.centroidLabels || [];
              }
            }
          }
        }
      } catch (err) {
        console.error(`[State] Failed to load ${level}D positions:`, err);
        // Revert to previous level
        if (ctx) ctx.dimensionLevel = previousLevel;
        if (isActiveView) this.activeDimensionLevel = previousLevel;
        this.dimensionManager.setViewDimension(targetViewId, previousLevel);
        throw err;
      }
    }

    // Update viewer's per-view dimension tracking for multiview rendering
    if (this.viewer && this.viewer.setViewDimension) {
      this.viewer.setViewDimension(targetViewId, level);
    }

    // Notify callbacks (only if active view changed, or always for UI sync)
    if (isActiveView) {
      this._notifyDimensionChange();
    }
  }

  /**
   * Set dimension level for a specific view (convenience method for multiview)
   * @param {string} viewId - View identifier
   * @param {number} level - Dimension level (1, 2, 3, or 4)
   * @returns {Promise<void>}
   */
  async setViewDimensionLevel(viewId, level) {
    return this.setDimensionLevel(level, { viewId, updateViewer: true });
  }

  /**
   * Update viewer with new positions
   * @param {Float32Array} positions3D - 3D positions array
   */
  _updateViewerPositions(positions3D) {
    if (!this.viewer) return;

    // Store as current positions
    this.positionsArray = positions3D;

    // Update viewer data
    if (this.viewer.updatePositions) {
      this.viewer.updatePositions(positions3D);
    } else if (this.viewer.setData) {
      // Full data reload if no incremental update available
      // Pass dimensionLevel to ensure correct spatial index is built
      this.viewer.setData({
        positions: positions3D,
        colors: this.colorsArray,
        outlierQuantiles: this.outlierQuantilesArray,
        transparency: this.categoryTransparency,
        dimensionLevel: this.activeDimensionLevel
      });
    }
  }

  /**
   * Add callback for dimension changes
   * @param {Function} callback - Callback function
   */
  addDimensionChangeCallback(callback) {
    if (typeof callback === 'function') {
      this._dimensionChangeCallbacks.add(callback);
    }
  }

  /**
   * Remove dimension change callback
   * @param {Function} callback - Callback to remove
   */
  removeDimensionChangeCallback(callback) {
    this._dimensionChangeCallbacks.delete(callback);
  }

  /**
   * Notify all dimension change callbacks
   */
  _notifyDimensionChange() {
    const level = this.activeDimensionLevel;
    this._dimensionChangeCallbacks.forEach((cb) => {
      try {
        cb(level);
      } catch (err) {
        console.error('[State] Dimension change callback failed:', err);
      }
    });
  }

  /**
   * Reset dimension level without loading positions (for dataset reload)
   * Used when switching datasets - positions are already loaded via initScene
   * @param {number} level - New dimension level
   */
  resetDimensionLevel(level) {
    this.activeDimensionLevel = level;

    // Clear all view context dimension levels
    for (const ctx of this.viewContexts.values()) {
      ctx.dimensionLevel = level;
    }

    // Notify callbacks
    this._notifyDimensionChange();
  }

  /**
   * Get available dimensions from dimension manager
   * @returns {number[]} Array of available dimension levels
   */
  getAvailableDimensions() {
    return this.dimensionManager?.getAvailableDimensions() ?? [3];
  }

  /**
   * Check if a specific dimension is available
   * @param {number} dim - Dimension level
   * @returns {boolean}
   */
  hasDimension(dim) {
    return this.dimensionManager?.hasDimension(dim) ?? (dim === 3);
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
      activeFieldSource: this.activeFieldSource,
      dimensionLevel: this.activeDimensionLevel // Include dimension level in context
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

  captureCurrentContext() {
    return this._buildContextFromCurrent(this.activeViewId || 'live', { cloneArrays: true });
  }

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

    // Ensure global overlays are applied after any context restore.
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
  }

  _syncActiveContext() {
    const ctx = this.viewContexts.get(String(this.activeViewId));
    if (!ctx) return;
    // Clone obsData and varData to prevent shared mutation
    ctx.obsData = this._cloneObsData(this.obsData);
    ctx.varData = this._cloneVarData(this.varData);
    ctx.activeFieldIndex = this.activeFieldIndex;
    ctx.activeVarFieldIndex = this.activeVarFieldIndex;
    ctx.activeFieldSource = this.activeFieldSource;
    // Clone arrays to prevent shared mutation between views
    ctx.colorsArray = this.colorsArray ? new Uint8Array(this.colorsArray) : null;
    ctx.categoryTransparency = this.categoryTransparency ? new Float32Array(this.categoryTransparency) : null;
    ctx.outlierQuantilesArray = this.outlierQuantilesArray ? new Float32Array(this.outlierQuantilesArray) : null;
    ctx.centroidPositions = this.centroidPositions ? new Float32Array(this.centroidPositions) : null;
    ctx.centroidColors = this.centroidColors ? new Uint8Array(this.centroidColors) : null; // RGBA uint8
    ctx.centroidOutliers = this.centroidOutliers ? new Float32Array(this.centroidOutliers) : null;
    ctx.centroidLabels = this.centroidLabels ? [...this.centroidLabels] : [];
    ctx.filteredCount = this.filteredCount ? { ...this.filteredCount } : { shown: 0, total: 0 };
    // Sync dimension level to context
    ctx.dimensionLevel = this.activeDimensionLevel;
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

    // Save current view's state before switching (ensures filter isolation)
    const prevKey = String(this.activeViewId || 'live');
    if (prevKey !== key) {
      const prevCtx = this.viewContexts.get(prevKey);
      if (prevCtx) {
        // Clone field state to ensure filter settings are preserved independently
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
        // Save dimension level for the previous view so it can be restored when switching back
        prevCtx.dimensionLevel = this.activeDimensionLevel;
      }
    }

    this.activeViewId = ctx.id;
    if (this.viewer && typeof this.viewer.setViewLayout === 'function') {
      this.viewer.setViewLayout('grid', this.activeViewId);
    }
    // Clone obsData/varData to ensure this view's state is independent
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

    // Apply global overlays (rename/delete/user-defined) to the freshly-cloned field metadata.
    // This keeps view switching stable without touching render buffers.
    this._applyOverlaysToFields(this.obsData?.fields, FieldSource.OBS);
    this._applyOverlaysToFields(this.varData?.fields, FieldSource.VAR);
    this._injectUserDefinedFields();
    this._ensureActiveSelectionNotDeleted();
    getFieldRegistry().invalidate();

    // IMPORTANT: Sync dimension level from the view's context
    // This ensures the active dimension level matches the view being switched to
    const viewDimLevel = ctx.dimensionLevel ?? this.dimensionManager?.getDefaultDimension() ?? 3;
    if (viewDimLevel !== this.activeDimensionLevel) {
      this.activeDimensionLevel = viewDimLevel;
      // Update dimension manager's tracking (no position loading needed - view already has its positions)
      if (this.dimensionManager) {
        this.dimensionManager.setViewDimension(ctx.id, viewDimLevel);
      }
      // Notify dimension change callbacks (e.g., UI slider update)
      this._notifyDimensionChange();
    }

    // Reinitialize the active field to ensure category counts and metadata are up-to-date
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
  }

  /**
   * Reinitialize the active field's metadata after switching views.
   * Ensures category counts and metadata are available for the legend UI.
   * Does NOT recompute colors/transparency - those are loaded from the context.
   */
  _reinitializeActiveField() {
    const field = this.getActiveField();
    if (!field || !field.loaded) return;

    if (field.kind === 'continuous') {
      // Ensure continuous metadata exists
      this.ensureContinuousMetadata(field);
    } else if (field.kind === 'category') {
      // Ensure category metadata (colors, visibility maps)
      this.ensureCategoryMetadata(field);
      // Recompute category counts based on current transparency/visibility
      const counts = this.computeCategoryCountsForField(field);
      if (counts) {
        field._categoryCounts = counts;
        this._activeCategoryCounts = counts;
      }
    }
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

  /**
   * Get centroids for the current dimension from a field
   * @param {Object} field - The field object with centroidsByDim
   * @returns {Array} Centroid array for current dimension
   */
  _getCentroidsForCurrentDim(field) {
    if (!field) return [];
    const currentDim = this.activeDimensionLevel || 3;
    const centroidsByDim = field.centroidsByDim || {};
    return centroidsByDim[String(currentDim)]
      || centroidsByDim[currentDim]
      || [];
  }

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
  }

  /**
   * Initialize the scene with positions and observation data.
   * @param {Float32Array} positions - Already-normalized 3D positions from DimensionManager
   * @param {Object} obs - Observation data with fields and centroids
   */
  initScene(positions, obs) {
    const normalizedFields = (obs?.fields || []).map((field) => ({
      ...field,
      loaded: Boolean(field?.values || field?.codes),
      _loadingPromise: null,
      _normalizedDims: null // Reset normalization tracking for new dataset
    }));
    this.obsData = { ...obs, fields: normalizedFields };
    this._fieldDataCache.clear();
    this._varFieldDataCache.clear();

    // Development phase: a dataset load is a hard reset for all field-operation state.
    // Saved sessions can be regenerated, so we do not carry registry state across datasets.
    this._renameRegistry.clear();
    this._deleteRegistry.clear();
    this._userDefinedFields.clear();
    getFieldRegistry().invalidate();

    // Positions are already normalized by DimensionManager.getPositions3D().
    // Centroid normalization is now handled lazily in buildCentroidsForField() to ensure
    // each dimension's centroids are normalized with their correct transform.
    this.positionsArray = positions;

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

    // Pass dimensionLevel to ensure correct spatial index is built (BinaryTree/Quadtree/Octree)
    // activeDimensionLevel is set by setDimensionManager() which is called before initScene()
    // This fixes the bug where 1D/2D datasets were incorrectly treated as 3D
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
      colors: new Uint8Array(), // RGBA uint8 (matches centroid attribute format)
      outlierQuantiles: new Float32Array(),
      transparency: new Float32Array()
    });
    this.viewer.setCentroidLabels([]);

    // Reset highlight state on dataset reload
    this.highlightPages = [];
    this.activePageId = null;
    this._highlightPageIdCounter = 0;
    this.highlightArray = new Uint8Array(this.pointCount);
    this._highlightIdCounter = 0;
    this._cachedHighlightCount = null;
    this._cachedTotalHighlightCount = null;
    this._cachedHighlightLodLevel = null;

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
    // Invalidate only visible highlight count (total doesn't change with visibility)
    this._invalidateHighlightCountCache(true);
    if (!this._visibilityChangeCallbacks || this._visibilityChangeCallbacks.size === 0) return;
    this._visibilityChangeCallbacks.forEach((cb) => {
      try { cb(); }
      catch (err) { console.error('Visibility change callback failed', err); }
    });
  }

  // --- Field operation callbacks ---------------------------------------------

  addFieldChangeCallback(callback) {
    if (typeof callback === 'function') {
      this._fieldChangeCallbacks.add(callback);
    }
  }

  removeFieldChangeCallback(callback) {
    this._fieldChangeCallbacks.delete(callback);
  }

  _notifyFieldChange(source, fieldIndex, changeType, detail = null) {
    if (!this._fieldChangeCallbacks || this._fieldChangeCallbacks.size === 0) return;
    const event = { source, fieldIndex, changeType, detail };
    this._fieldChangeCallbacks.forEach((cb) => {
      try { cb(event); }
      catch (err) { console.error('Field change callback failed', err); }
    });
  }

  // Returns per-point visibility (0 = hidden, 1 = visible) including outlier filtering
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
  }

  // Returns normalized positions for all points currently visible in the scatter
  // (respecting category filters, continuous filters, and outlier filtering).
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

  // --- Field operations (rename / delete / user-defined) ----------------------

  getRenameRegistry() { return this._renameRegistry; }
  getDeleteRegistry() { return this._deleteRegistry; }
  getUserDefinedFieldsRegistry() { return this._userDefinedFields; }

  /**
   * Apply rename/delete overlays stored in registries to the currently loaded field metadata.
   * This is safe to call during view switching because it does not touch render buffers.
   */
  applyFieldOverlays() {
    this._applyOverlaysToFields(this.obsData?.fields, FieldSource.OBS);
    this._applyOverlaysToFields(this.varData?.fields, FieldSource.VAR);
    this._injectUserDefinedFields();

    // Keep active selection pointing at a non-deleted field (buffers remain untouched).
    this._ensureActiveSelectionNotDeleted();

    getFieldRegistry().invalidate();
    this._syncActiveContext();
  }

  getVisibleFields(source) {
    return getFieldRegistry().getVisibleFields(source);
  }

  isFieldDeleted(source, fieldIndex) {
    const fields = source === FieldSource.VAR ? this.varData?.fields : this.obsData?.fields;
    return fields?.[fieldIndex]?._isDeleted === true;
  }

  renameField(source, fieldIndex, newKey) {
    const src = source === FieldSource.VAR ? FieldSource.VAR : FieldSource.OBS;
    const fields = src === FieldSource.VAR ? this.varData?.fields : this.obsData?.fields;

    try {
      StateValidator.validateFieldIndex(fieldIndex, fields);
      StateValidator.validateFieldKey(newKey);
    } catch (e) {
      console.error('[State] renameField validation failed:', e.message);
      return false;
    }

    if (StateValidator.isDuplicateKey(newKey, fields, fieldIndex)) {
      console.error('[State] renameField: duplicate key', newKey);
      return false;
    }

    const field = fields[fieldIndex];
    if (!field) return false;

    const isUserDefined = field._isUserDefined === true && field._userDefinedId;

    if (!field._originalKey) {
      field._originalKey = field.key;
    }

    const originalKey = field._originalKey;
    const previousKey = field.key;

    if (newKey === originalKey) {
      field.key = originalKey;
      delete field._originalKey;
      if (!isUserDefined) {
        this._renameRegistry.revertFieldRename(src, originalKey);
      }
    } else {
      field.key = newKey;
      if (!isUserDefined) {
        this._renameRegistry.setFieldRename(src, originalKey, newKey);
      }
    }

    if (isUserDefined) {
      this._userDefinedFields?.updateField?.(field._userDefinedId, { key: field.key });
    }

    this._refreshHighlightGroupsForField(src, fieldIndex);
    getFieldRegistry().invalidate();
    this.updateFilterSummary();
    this._syncActiveContext();
    this._notifyFieldChange(src, fieldIndex, ChangeType.RENAME, { originalKey, previousKey, newKey: field.key });
    return true;
  }

  /**
   * Revert a field rename back to its original key (if renamed).
   * @param {string} source - 'obs' | 'var'
   * @param {number} fieldIndex
   * @returns {boolean}
   */
  revertFieldRename(source, fieldIndex) {
    const src = source === FieldSource.VAR ? FieldSource.VAR : FieldSource.OBS;
    const fields = src === FieldSource.VAR ? this.varData?.fields : this.obsData?.fields;

    try {
      StateValidator.validateFieldIndex(fieldIndex, fields);
    } catch (e) {
      console.error('[State] revertFieldRename validation failed:', e.message);
      return false;
    }

    const field = fields[fieldIndex];
    if (!field) return false;
    if (!field._originalKey) return true;
    return this.renameField(src, fieldIndex, field._originalKey);
  }

  renameCategory(source, fieldIndex, categoryIndex, newLabel) {
    const src = source === FieldSource.VAR ? FieldSource.VAR : FieldSource.OBS;
    const fields = src === FieldSource.VAR ? this.varData?.fields : this.obsData?.fields;

    try {
      StateValidator.validateFieldIndex(fieldIndex, fields);
      const field = fields[fieldIndex];
      StateValidator.validateCategoryIndex(categoryIndex, field);
      StateValidator.validateCategoryLabel(newLabel);
    } catch (e) {
      console.error('[State] renameCategory validation failed:', e.message);
      return false;
    }

    const field = fields[fieldIndex];
    const isUserDefined = field._isUserDefined === true && field._userDefinedId;

    if (!field._originalCategories) {
      field._originalCategories = [...field.categories];
    }

    const originalFieldKey = field._originalKey || field.key;
    const originalLabel = field._originalCategories?.[categoryIndex] ?? field.categories[categoryIndex];

    if (newLabel === String(originalLabel)) {
      // Revert this category label to its original.
      field.categories[categoryIndex] = originalLabel;
      if (!isUserDefined) {
        this._renameRegistry.revertCategoryRename(src, originalFieldKey, categoryIndex);
      }
    } else {
      field.categories[categoryIndex] = newLabel;
      if (!isUserDefined) {
        this._renameRegistry.setCategoryRename(src, originalFieldKey, categoryIndex, newLabel);
      }
    }

    if (isUserDefined && Array.isArray(field._originalCategories)) {
      const hasAnyRename = field.categories.some((label, idx) => String(label) !== String(field._originalCategories[idx]));
      if (!hasAnyRename) {
        delete field._originalCategories;
      }
    }

    // Keep centroid labels consistent with the category list.
    this._syncCentroidCategoryLabelAtIndex(field, categoryIndex);
    this._refreshHighlightGroupsForField(src, fieldIndex);

    // If this field is currently active, push centroid label updates.
    if (src === FieldSource.OBS && this.activeFieldSource === FieldSource.OBS && this.activeFieldIndex === fieldIndex) {
      this.buildCentroidsForField(field);
      this._pushCentroidsToViewer();
    }

    this.updateFilterSummary();
    this._syncActiveContext();
    this._notifyFieldChange(src, fieldIndex, ChangeType.CATEGORY_RENAME, { categoryIndex, newLabel: field.categories[categoryIndex] });
    return true;
  }

  /**
   * Create a new categorical obs column where one category is merged into a
   * single canonical `unassigned` bucket (accumulating deletions).
   *
   * This is a destructive edit of the category assignment:
   * - For source fields, we create a user-defined derived field and soft-delete
   *   the source field (restorable via Deleted Fields).
   * - For already user-defined derived fields, we edit the field in place to
   *   keep the workflow fast and avoid cluttering the field list. In this path
   *   we remap per-cell codes in place when possible to avoid allocating an
   *   additional full codes array on every edit.
   *
   * @param {number} fieldIndex
   * @param {number} categoryIndex
   * @param {object} [options]
   * @param {string} [options.unassignedLabel='unassigned']
   * @param {string} [options.newKey] - Optional explicit new field key
   * @returns {{ newFieldIndex: number, newKey: string }|null}
   */
  deleteCategoryToUnassigned(fieldIndex, categoryIndex, options = {}) {
    const fields = this.obsData?.fields;

    try {
      StateValidator.validateFieldIndex(fieldIndex, fields);
      const field = fields[fieldIndex];
      StateValidator.validateCategoryIndex(categoryIndex, field);
    } catch (e) {
      console.error('[State] deleteCategoryToUnassigned validation failed:', e.message);
      return null;
    }

    const sourceField = fields[fieldIndex];
    if (!sourceField || sourceField.kind !== FieldKind.CATEGORY) return null;
    if (sourceField._isDeleted === true) return null;

    const canEditInPlace = sourceField._isUserDefined === true && Boolean(sourceField._userDefinedId);
    const editInPlace = options.editInPlace !== false && canEditInPlace;

    const deletedLabel = String(sourceField.categories?.[categoryIndex] ?? '');
    const unassignedLabel = String(options.unassignedLabel ?? 'unassigned').trim() || 'unassigned';

    let transform;
    try {
      transform = buildDeleteToUnassignedTransform(sourceField.categories || [], categoryIndex, { unassignedLabel });
    } catch (err) {
      console.error('[State] deleteCategoryToUnassigned failed:', err.message);
      return null;
    }

    const nextCategories = transform.categories;

    // In-place edit for user-defined derived fields:
    // avoids creating another full field copy on repeated destructive edits.
    if (editInPlace) {
      // Prefer in-place remapping to avoid allocating a full codes copy on every edit.
      // Fallback to allocating when codes isn't a TypedArray (unexpected).
      let nextCodes = sourceField.codes;
      const didInPlace = applyCategoryIndexMappingInPlace(nextCodes, transform.mapping);
      if (!didInPlace) {
        nextCodes = applyCategoryIndexMapping(sourceField.codes, transform.mapping, nextCategories.length);
      }

      try {
        this.ensureCategoryMetadata(sourceField);
      } catch {}

      const oldColors = sourceField._categoryColors || [];
      const oldVisible = sourceField._categoryVisible || {};

      const newColors = new Array(nextCategories.length);
      const newVisible = {};
      for (let i = 0; i < nextCategories.length; i++) newVisible[i] = true;

      const merged = new Set(transform.mergedOldIndices || []);
      const unassignedOld = transform.keptOldUnassignedIndex;
      const unassignedNew = transform.unassignedNewIndex;

      // Unassigned bucket: prefer the kept old unassigned color, otherwise palette default.
      if (unassignedOld != null && oldColors[unassignedOld]) {
        newColors[unassignedNew] = oldColors[unassignedOld];
        newVisible[unassignedNew] = oldVisible[unassignedOld] !== false;
      } else {
        newColors[unassignedNew] = getCategoryColor(unassignedNew);
        newVisible[unassignedNew] = true;
      }

      // Copy remaining categories (skip those merged into unassigned).
      for (let oldIdx = 0; oldIdx < transform.mapping.length; oldIdx++) {
        if (oldIdx === unassignedOld) continue;
        if (merged.has(oldIdx)) continue;
        const newIdx = transform.mapping[oldIdx];
        const c = oldColors[oldIdx];
        if (c) newColors[newIdx] = c;
        newVisible[newIdx] = oldVisible[oldIdx] !== false;
      }

      sourceField.categories = nextCategories;
      if (!didInPlace) sourceField.codes = nextCodes;
      sourceField._categoryColors = newColors;
      sourceField._categoryVisible = newVisible;

      delete sourceField._originalCategories;
      delete sourceField.outlierQuantiles;
      delete sourceField._outlierThreshold;

      try {
        sourceField.centroidsByDim = this._userDefinedFields.computeCentroidsByDim(nextCodes, nextCategories, this);
      } catch (err) {
        console.warn('[State] deleteCategoryToUnassigned in-place centroid compute failed:', err);
      }

      sourceField._operation = {
        type: 'delete-to-unassigned',
        deletedCategoryIndex: categoryIndex,
        deletedCategoryLabel: deletedLabel,
        unassignedLabel: String(unassignedLabel)
      };

      // Keep serialized template in sync for persistence.
      const template = this._userDefinedFields?.getField?.(sourceField._userDefinedId);
      if (template) {
        template.categories = nextCategories;
        template.codes = sourceField.codes;
        if (sourceField.centroidsByDim) template.centroidsByDim = sourceField.centroidsByDim;
        template._operation = sourceField._operation;
      }

      // Remap any category-based highlight groups referencing this field.
      for (const page of this.highlightPages || []) {
        for (const group of (page.highlightedGroups || [])) {
          if (!group || group.type !== 'category') continue;
          if (group.fieldSource !== FieldSource.OBS) continue;
          if (group.fieldIndex !== fieldIndex) continue;
          const oldCat = group.categoryIndex;
          if (!Number.isInteger(oldCat) || oldCat < 0 || oldCat >= transform.mapping.length) continue;
          group.categoryIndex = transform.mapping[oldCat];
        }
      }

      getFieldRegistry().invalidate();
      this._syncActiveContext();

      try {
        this.setActiveField(fieldIndex);
      } catch (err) {
        console.warn('[State] Failed to re-activate edited field:', err);
      }

      this.updateFilterSummary();
      this._refreshHighlightGroupsForField(FieldSource.OBS, fieldIndex);
      this._notifyFieldChange(FieldSource.OBS, fieldIndex, ChangeType.UPDATE, {
        operation: 'delete-to-unassigned',
        unassignedLabel
      });

      // Note: restoration is still possible by restoring the original source column
      // that this user-defined field was derived from.
      return { newFieldIndex: fieldIndex, newKey: sourceField.key, updatedInPlace: true };
    }

    const nextCodes = applyCategoryIndexMapping(sourceField.codes, transform.mapping, nextCategories.length);

    const rootKey = sourceField._sourceField?.sourceKey || sourceField._originalKey || sourceField.key;
    const baseKey = String(options.newKey || `${rootKey} (edited)`).trim() || `${rootKey} (edited)`;
    const existingKeys = (fields || []).filter((f) => f && f._isDeleted !== true).map((f) => f.key);
    const newKey = makeUniqueLabel(baseKey, existingKeys);

    let created;
    try {
      created = this._userDefinedFields.createFromCategoricalCodes(
        {
          key: newKey,
          categories: nextCategories,
          codes: nextCodes,
          meta: {
            _sourceField: {
              kind: 'categorical-obs',
              sourceKey: rootKey,
              sourceIndex: fieldIndex
            },
            _operation: {
              type: 'delete-to-unassigned',
              deletedCategoryIndex: categoryIndex,
              deletedCategoryLabel: String(sourceField.categories?.[categoryIndex] ?? ''),
              unassignedLabel: String(unassignedLabel)
            }
          }
        },
        this
      );
    } catch (err) {
      console.error('[State] deleteCategoryToUnassigned create failed:', err.message);
      return null;
    }

    const derivedField = created.field;

    // Carry forward category UI state (colors/visibility) as a convenience.
    try {
      this.ensureCategoryMetadata(sourceField);
      const newColors = new Array(nextCategories.length);
      const newVisible = {};
      for (let i = 0; i < nextCategories.length; i++) newVisible[i] = true;

      const oldColors = sourceField._categoryColors || [];
      const oldVisible = sourceField._categoryVisible || {};

      // Unassigned bucket: prefer the kept old unassigned color, otherwise palette default.
      const unassignedOld = transform.keptOldUnassignedIndex;
      const unassignedNew = transform.unassignedNewIndex;
      if (unassignedOld != null && oldColors[unassignedOld]) {
        newColors[unassignedNew] = oldColors[unassignedOld];
        newVisible[unassignedNew] = oldVisible[unassignedOld] !== false;
      } else {
        newColors[unassignedNew] = getCategoryColor(unassignedNew);
        newVisible[unassignedNew] = true;
      }

      // Copy remaining categories (skip those merged into unassigned).
      const merged = new Set(transform.mergedOldIndices || []);
      for (let oldIdx = 0; oldIdx < transform.mapping.length; oldIdx++) {
        if (oldIdx === unassignedOld) continue;
        if (merged.has(oldIdx)) continue;
        const newIdx = transform.mapping[oldIdx];
        const c = oldColors[oldIdx];
        if (c) newColors[newIdx] = c;
        newVisible[newIdx] = oldVisible[oldIdx] !== false;
      }

      derivedField._categoryColors = newColors;
      derivedField._categoryVisible = newVisible;
      derivedField._categoryFilterEnabled = sourceField._categoryFilterEnabled ?? true;
      if (sourceField._colormapId) derivedField._colormapId = sourceField._colormapId;
    } catch (err) {
      console.warn('[State] Failed to carry category UI state to derived field:', err);
    }

    // Ensure this derived field does not carry latent outlier filtering state.
    delete derivedField.outlierQuantiles;
    delete derivedField._outlierThreshold;

    fields.push(derivedField);
    const newFieldIndex = fields.length - 1;

    getFieldRegistry().invalidate();
    this._syncActiveContext();
    this._notifyFieldChange(FieldSource.OBS, newFieldIndex, ChangeType.CREATE, { userDefinedId: created.id });

    // Activate new field before deleting the previous one (avoids a brief "no field" state).
    try {
      this.setActiveField(newFieldIndex);
    } catch (err) {
      console.warn('[State] Failed to activate derived field:', err);
    }

    // Soft-delete the source field for a clean UX; restoration is available in Deleted Fields.
    this.deleteField(FieldSource.OBS, fieldIndex);

    return { newFieldIndex, newKey };
  }

  /**
   * Create a new categorical obs column where one category is merged into another.
   *
   * Implemented as:
   * - For source fields, a derived user-defined field + soft-delete of the source field.
   * - For user-defined derived fields, an in-place edit (with in-place code remapping
   *   when possible) to support repeated drag-merge workflows without repeated large
   *   allocations or a growing field list.
   *
   * @param {number} fieldIndex
   * @param {number} fromCategoryIndex
   * @param {number} toCategoryIndex
   * @param {object} [options]
   * @param {string} [options.newKey]
   * @returns {{ newFieldIndex: number, newKey: string }|null}
   */
  mergeCategoriesToNewField(fieldIndex, fromCategoryIndex, toCategoryIndex, options = {}) {
    const fields = this.obsData?.fields;

    try {
      StateValidator.validateFieldIndex(fieldIndex, fields);
      const field = fields[fieldIndex];
      StateValidator.validateCategoryIndex(fromCategoryIndex, field);
      StateValidator.validateCategoryIndex(toCategoryIndex, field);
    } catch (e) {
      console.error('[State] mergeCategoriesToNewField validation failed:', e.message);
      return null;
    }

    const sourceField = fields[fieldIndex];
    if (!sourceField || sourceField.kind !== FieldKind.CATEGORY) return null;
    if (sourceField._isDeleted === true) return null;

    const canEditInPlace = sourceField._isUserDefined === true && Boolean(sourceField._userDefinedId);
    const editInPlace = options.editInPlace !== false && canEditInPlace;

    let transform;
    try {
      transform = buildMergeCategoriesTransform(sourceField.categories || [], fromCategoryIndex, toCategoryIndex);
    } catch (err) {
      console.error('[State] mergeCategoriesToNewField failed:', err.message);
      return null;
    }

    const nextCategories = transform.categories;
    const fromLabel = String(sourceField.categories?.[fromCategoryIndex] ?? '');
    const toLabel = String(sourceField.categories?.[toCategoryIndex] ?? '');
    const targetNewIndex = transform.targetNewIndex;

    // Rename the merged bucket so the result is explicit to the user.
    // The merged label is "dragged + target" so drag direction is visible.
    const mergedBase = String(options.mergedLabel ?? `merged ${fromLabel} + ${toLabel}`).trim() || 'merged';
    const mergedLabel = makeUniqueLabel(
      mergedBase,
      nextCategories.filter((_, idx) => idx !== targetNewIndex)
    );
    if (nextCategories[targetNewIndex] != null) {
      nextCategories[targetNewIndex] = mergedLabel;
    }

    if (editInPlace) {
      // Prefer in-place remapping to avoid allocating a full codes copy on every edit.
      // Fallback to allocating when codes isn't a TypedArray (unexpected).
      let nextCodes = sourceField.codes;
      const didInPlace = applyCategoryIndexMappingInPlace(nextCodes, transform.mapping);
      if (!didInPlace) {
        nextCodes = applyCategoryIndexMapping(sourceField.codes, transform.mapping, nextCategories.length);
      }

      try {
        this.ensureCategoryMetadata(sourceField);
      } catch {}

      const oldColors = sourceField._categoryColors || [];
      const oldVisible = sourceField._categoryVisible || {};
      const newColors = new Array(nextCategories.length);
      const newVisible = {};
      for (let i = 0; i < nextCategories.length; i++) newVisible[i] = true;

      // Merged bucket color should come from the dragged category.
      const draggedColor = oldColors[fromCategoryIndex] || getCategoryColor(fromCategoryIndex);
      newColors[targetNewIndex] = draggedColor;
      newVisible[targetNewIndex] = (oldVisible[fromCategoryIndex] !== false) || (oldVisible[toCategoryIndex] !== false);

      for (let oldIdx = 0; oldIdx < transform.mapping.length; oldIdx++) {
        if (oldIdx === fromCategoryIndex || oldIdx === toCategoryIndex) continue;
        const newIdx = transform.mapping[oldIdx];
        const c = oldColors[oldIdx];
        if (c) newColors[newIdx] = c;
        newVisible[newIdx] = oldVisible[oldIdx] !== false;
      }

      sourceField.categories = nextCategories;
      if (!didInPlace) sourceField.codes = nextCodes;
      sourceField._categoryColors = newColors;
      sourceField._categoryVisible = newVisible;

      delete sourceField._originalCategories;
      delete sourceField.outlierQuantiles;
      delete sourceField._outlierThreshold;

      try {
        sourceField.centroidsByDim = this._userDefinedFields.computeCentroidsByDim(nextCodes, nextCategories, this);
      } catch (err) {
        console.warn('[State] mergeCategoriesToNewField in-place centroid compute failed:', err);
      }

      sourceField._operation = {
        type: 'merge-categories',
        fromCategoryIndex,
        toCategoryIndex,
        fromCategoryLabel: fromLabel,
        toCategoryLabel: toLabel,
        mergedCategoryLabel: mergedLabel
      };

      // Keep serialized template in sync for persistence.
      const template = this._userDefinedFields?.getField?.(sourceField._userDefinedId);
      if (template) {
        template.categories = nextCategories;
        template.codes = sourceField.codes;
        if (sourceField.centroidsByDim) template.centroidsByDim = sourceField.centroidsByDim;
        template._operation = sourceField._operation;
      }

      // Remap any category-based highlight groups referencing this field.
      for (const page of this.highlightPages || []) {
        for (const group of (page.highlightedGroups || [])) {
          if (!group || group.type !== 'category') continue;
          if (group.fieldSource !== FieldSource.OBS) continue;
          if (group.fieldIndex !== fieldIndex) continue;
          const oldCat = group.categoryIndex;
          if (!Number.isInteger(oldCat) || oldCat < 0 || oldCat >= transform.mapping.length) continue;
          group.categoryIndex = transform.mapping[oldCat];
        }
      }

      getFieldRegistry().invalidate();
      this._syncActiveContext();

      try {
        this.setActiveField(fieldIndex);
      } catch (err) {
        console.warn('[State] Failed to re-activate merged field:', err);
      }

      this.updateFilterSummary();
      this._refreshHighlightGroupsForField(FieldSource.OBS, fieldIndex);
      this._notifyFieldChange(FieldSource.OBS, fieldIndex, ChangeType.UPDATE, {
        operation: 'merge-categories',
        mergedCategoryLabel: mergedLabel
      });

      return { newFieldIndex: fieldIndex, newKey: sourceField.key, updatedInPlace: true, mergedCategoryLabel: mergedLabel };
    }

    const nextCodes = applyCategoryIndexMapping(sourceField.codes, transform.mapping, nextCategories.length);

    const rootKey = sourceField._sourceField?.sourceKey || sourceField._originalKey || sourceField.key;
    const baseKey = String(options.newKey || `${rootKey} (merged)`).trim() || `${rootKey} (merged)`;
    const existingKeys = (fields || []).filter((f) => f && f._isDeleted !== true).map((f) => f.key);
    const newKey = makeUniqueLabel(baseKey, existingKeys);

    let created;
    try {
      created = this._userDefinedFields.createFromCategoricalCodes(
        {
          key: newKey,
          categories: nextCategories,
          codes: nextCodes,
          meta: {
            _sourceField: {
              kind: 'categorical-obs',
              sourceKey: rootKey,
              sourceIndex: fieldIndex
            },
            _operation: {
              type: 'merge-categories',
              fromCategoryIndex,
              toCategoryIndex,
              fromCategoryLabel: String(sourceField.categories?.[fromCategoryIndex] ?? ''),
              toCategoryLabel: String(sourceField.categories?.[toCategoryIndex] ?? '')
            }
          }
        },
        this
      );
    } catch (err) {
      console.error('[State] mergeCategoriesToNewField create failed:', err.message);
      return null;
    }

    const derivedField = created.field;

    // Carry forward category UI state (colors/visibility).
    try {
      this.ensureCategoryMetadata(sourceField);
      const newColors = new Array(nextCategories.length);
      const newVisible = {};
      for (let i = 0; i < nextCategories.length; i++) newVisible[i] = true;

      const oldColors = sourceField._categoryColors || [];
      const oldVisible = sourceField._categoryVisible || {};

      // Merged bucket color comes from the dragged category.
      const draggedColor = oldColors[fromCategoryIndex] || getCategoryColor(fromCategoryIndex);
      newColors[targetNewIndex] = draggedColor;
      newVisible[targetNewIndex] = (oldVisible[fromCategoryIndex] !== false) || (oldVisible[toCategoryIndex] !== false);

      // Copy remaining categories (skip merged source and avoid overwriting merged bucket).
      for (let oldIdx = 0; oldIdx < transform.mapping.length; oldIdx++) {
        if (oldIdx === fromCategoryIndex || oldIdx === toCategoryIndex) continue;
        const newIdx = transform.mapping[oldIdx];
        const c = oldColors[oldIdx];
        if (c) newColors[newIdx] = c;
        newVisible[newIdx] = oldVisible[oldIdx] !== false;
      }

      derivedField._categoryColors = newColors;
      derivedField._categoryVisible = newVisible;
      derivedField._categoryFilterEnabled = sourceField._categoryFilterEnabled ?? true;
      if (sourceField._colormapId) derivedField._colormapId = sourceField._colormapId;
    } catch (err) {
      console.warn('[State] Failed to carry category UI state to merged field:', err);
    }

    delete derivedField.outlierQuantiles;
    delete derivedField._outlierThreshold;

    fields.push(derivedField);
    const newFieldIndex = fields.length - 1;

    getFieldRegistry().invalidate();
    this._syncActiveContext();
    this._notifyFieldChange(FieldSource.OBS, newFieldIndex, ChangeType.CREATE, { userDefinedId: created.id });

    try {
      this.setActiveField(newFieldIndex);
    } catch (err) {
      console.warn('[State] Failed to activate merged field:', err);
    }

    this.deleteField(FieldSource.OBS, fieldIndex);

    return { newFieldIndex, newKey, mergedCategoryLabel: mergedLabel };
  }

  deleteField(source, fieldIndex) {
    const src = source === FieldSource.VAR ? FieldSource.VAR : FieldSource.OBS;
    const fields = src === FieldSource.VAR ? this.varData?.fields : this.obsData?.fields;

    try {
      StateValidator.validateFieldIndex(fieldIndex, fields);
    } catch (e) {
      console.error('[State] deleteField validation failed:', e.message);
      return false;
    }

    const field = fields[fieldIndex];
    if (!field) return false;

    if (field._isUserDefined && field._userDefinedId) {
      return this.deleteUserDefinedField(field._userDefinedId, src);
    }

    const originalKey = field._originalKey || field.key;
    this._deleteRegistry.markDeleted(src, originalKey);
    field._isDeleted = true;

    const wasActive =
      (src === FieldSource.OBS && this.activeFieldSource === FieldSource.OBS && this.activeFieldIndex === fieldIndex) ||
      (src === FieldSource.VAR && this.activeFieldSource === FieldSource.VAR && this.activeVarFieldIndex === fieldIndex);

    if (wasActive) {
      this.clearActiveField();
    }

    if (src === FieldSource.VAR) {
      // Free memory when possible; preserveActive prevents unloading if any view still references it.
      this.unloadVarField(fieldIndex, { preserveActive: true });
    }

    getFieldRegistry().invalidate();
    if (!wasActive) this.computeGlobalVisibility();
    this.updateFilterSummary();
    this._notifyFieldChange(src, fieldIndex, ChangeType.DELETE, { originalKey });
    return true;
  }

  /**
   * Permanently confirm a deleted field so it is no longer restorable.
   *
   * This is intentionally destructive and should only be called from a user
   * confirmation flow (e.g., the Deleted Fields "Confirm" button).
   *
   * @param {'obs'|'var'} source
   * @param {number} fieldIndex
   * @returns {boolean}
   */
  purgeDeletedField(source, fieldIndex) {
    const src = source === FieldSource.VAR ? FieldSource.VAR : FieldSource.OBS;
    const fields = src === FieldSource.VAR ? this.varData?.fields : this.obsData?.fields;

    try {
      StateValidator.validateFieldIndex(fieldIndex, fields);
    } catch (e) {
      console.error('[State] purgeDeletedField validation failed:', e.message);
      return false;
    }

    const field = fields?.[fieldIndex];
    if (!field) return false;
    if (field._isDeleted !== true) return false;
    if (field._isPurged === true) return true;

    const isUserDefined = field._isUserDefined === true && field._userDefinedId;

    if (isUserDefined) {
      field._isPurged = true;
      const template = this._userDefinedFields?.getField?.(field._userDefinedId);
      if (template) {
        template._isDeleted = true;
        template._isPurged = true;
      }
    } else {
      const originalKey = field._originalKey || field.key;
      this._deleteRegistry.markPurged(src, originalKey);
      field._isDeleted = true;
      field._isPurged = true;
    }

    getFieldRegistry().invalidate();
    this.computeGlobalVisibility();
    this.updateFilterSummary();
    this._notifyFieldChange(src, fieldIndex, ChangeType.UPDATE, { purged: true, userDefinedId: field._userDefinedId || null });
    return true;
  }

  /**
   * Restore a soft-deleted field.
   *
   * Returns a structured result (instead of a boolean) so the UI can surface
   * auto-rename details when restoring would create a duplicate visible key.
   *
   * @param {string} source - 'obs' | 'var'
   * @param {number} fieldIndex
   * @returns {{
   *   ok: boolean,
   *   originalKey?: string,
   *   key?: string,
   *   userDefinedId?: (string|null),
   *   renamedFrom?: (string|null),
   *   renamedTo?: (string|null)
   * }}
   */
  restoreField(source, fieldIndex) {
    const src = source === FieldSource.VAR ? FieldSource.VAR : FieldSource.OBS;
    const fields = src === FieldSource.VAR ? this.varData?.fields : this.obsData?.fields;
    const field = fields?.[fieldIndex];
    if (!field) return { ok: false };

    if (field._isPurged === true) {
      console.warn('[State] restoreField: cannot restore a confirmed deletion');
      return { ok: false };
    }

    const isUserDefined = field._isUserDefined === true && field._userDefinedId;
    const originalKey = field._originalKey || field.key;

    if (isUserDefined) {
      delete field._isDeleted;
      const template = this._userDefinedFields?.getField?.(field._userDefinedId);
      if (template) delete template._isDeleted;
    } else {
      this._deleteRegistry.markRestored(src, originalKey);
      delete field._isDeleted;
    }

    // If restoring causes a key conflict, auto-rename the restored field to keep
    // visible field keys unique (prevents selectors/filters from breaking).
    let renamedFrom = null;
    let renamedTo = null;
    const existingKeys = (fields || [])
      .map((f, idx) => ({ f, idx }))
      .filter(({ f, idx }) => idx !== fieldIndex && f && f._isDeleted !== true)
      .map(({ f }) => f.key);

    if (existingKeys.includes(field.key)) {
      renamedFrom = field.key;
      renamedTo = makeUniqueLabel(`${field.key} (restored)`, existingKeys);

      if (isUserDefined) {
        field.key = renamedTo;
        this._userDefinedFields?.updateField?.(field._userDefinedId, { key: renamedTo });
      } else {
        const okRename = this.renameField(src, fieldIndex, renamedTo);
        if (!okRename) {
          field.key = renamedTo;
        }
      }
    }

    getFieldRegistry().invalidate();
    this.computeGlobalVisibility();
    this.updateFilterSummary();
    this._notifyFieldChange(src, fieldIndex, ChangeType.RESTORE, {
      originalKey,
      userDefinedId: isUserDefined ? field._userDefinedId : null,
      renamedFrom,
      renamedTo
    });
    return {
      ok: true,
      originalKey,
      userDefinedId: isUserDefined ? field._userDefinedId : null,
      renamedFrom,
      renamedTo,
      key: field.key
    };
  }

  /**
   * Duplicate a field as a new user-defined field.
   *
   * - Categorical obs: deep-copies codes + categories and computes centroids.
   * - Continuous obs/var: creates a continuous alias that re-materializes values from
   *   the referenced source field when loading state snapshots.
   *
   * This is a non-destructive operation (the source field remains intact).
   *
   * @param {'obs'|'var'} source
   * @param {number} fieldIndex
   * @param {object} [options]
   * @param {string} [options.newKey]
   * @returns {Promise<{ newFieldIndex: number, newKey: string }|null>}
   */
  async duplicateField(source, fieldIndex, options = {}) {
    const src = source === FieldSource.VAR ? FieldSource.VAR : FieldSource.OBS;
    const fields = src === FieldSource.VAR ? this.varData?.fields : this.obsData?.fields;

    try {
      StateValidator.validateFieldIndex(fieldIndex, fields);
    } catch (e) {
      console.error('[State] duplicateField validation failed:', e.message);
      return null;
    }

    const field = fields?.[fieldIndex];
    if (!field || field._isDeleted === true) return null;

    // Ensure the source field has its heavy data materialized first.
    try {
      if (src === FieldSource.VAR) {
        await this.ensureVarFieldLoaded(fieldIndex);
      } else {
        await this.ensureFieldLoaded(fieldIndex);
      }
    } catch (err) {
      console.error('[State] duplicateField load failed:', err);
      return null;
    }

    const existingKeys = (fields || []).filter((f) => f && f._isDeleted !== true).map((f) => f.key);
    const baseKey = String(options.newKey || `${field.key} (copy)`).trim() || `${field.key} (copy)`;
    const newKey = makeUniqueLabel(baseKey, existingKeys);

    // ---------------------------------------------------------------------
    // Categorical obs: deep copy codes so subsequent merges don't affect the original.
    // ---------------------------------------------------------------------
    if (field.kind === FieldKind.CATEGORY) {
      if (src !== FieldSource.OBS) {
        console.warn('[State] duplicateField: categorical var fields are not supported');
        return null;
      }

      const categories = Array.isArray(field.categories) ? [...field.categories] : [];
      const codes = field.codes;
      if (!codes || typeof codes.length !== 'number') return null;
      const codesCopy = typeof codes.slice === 'function' ? codes.slice() : codes;

      const sourceKey = field._sourceField?.sourceKey || field._originalKey || field.key;
      const created = this._userDefinedFields.createFromCategoricalCodes(
        {
          key: newKey,
          categories,
          codes: codesCopy,
          source: FieldSource.OBS,
          meta: {
            _sourceField: {
              kind: 'categorical-obs',
              sourceKey,
              sourceIndex: fieldIndex
            },
            _operation: {
              type: 'copy-field',
              source: FieldSource.OBS,
              sourceKey
            }
          }
        },
        this
      );

      // Carry forward category UI state (colors/visibility) as a convenience.
      try {
        this.ensureCategoryMetadata(field);
        const colors = (field._categoryColors || []).map((c) => (Array.isArray(c) ? [...c] : c));
        const visible = { ...(field._categoryVisible || {}) };
        created.field._categoryColors = colors;
        created.field._categoryVisible = visible;
        created.field._categoryFilterEnabled = field._categoryFilterEnabled ?? true;
        if (field._colormapId) created.field._colormapId = field._colormapId;
      } catch (err) {
        console.warn('[State] duplicateField: failed to carry categorical UI state:', err);
      }

      fields.push(created.field);
      const newFieldIndex = fields.length - 1;

      getFieldRegistry().invalidate();
      this._syncActiveContext();
      this._notifyFieldChange(FieldSource.OBS, newFieldIndex, ChangeType.CREATE, { userDefinedId: created.id });

      return { newFieldIndex, newKey };
    }

    // ---------------------------------------------------------------------
    // Continuous obs/var: create an alias that can be re-materialized on load.
    // ---------------------------------------------------------------------
    if (field.kind === FieldKind.CONTINUOUS) {
      const sourceKey = field._originalKey || field.key;
      const kind = src === FieldSource.VAR ? 'gene-expression' : 'continuous-obs';
      const created = this._userDefinedFields.createContinuousAlias({
        key: newKey,
        source: src,
        sourceField: { kind, sourceKey, sourceIndex: fieldIndex },
        meta: {
          _operation: { type: 'copy-field', source: src, sourceKey }
        }
      });

      const aliasField = created.field;
      const values = field.values;
      if (values && typeof values.length === 'number') {
        aliasField.values = typeof values.slice === 'function' ? values.slice() : values;
        aliasField.loaded = true;
      }
      if (src === FieldSource.OBS && field.outlierQuantiles) {
        aliasField.outlierQuantiles = field.outlierQuantiles;
      }

      // Carry forward continuous UI state.
      if (field._continuousStats) aliasField._continuousStats = { ...field._continuousStats };
      if (field._continuousFilter) aliasField._continuousFilter = { ...field._continuousFilter };
      if (field._continuousColorRange) aliasField._continuousColorRange = { ...field._continuousColorRange };
      if (field._positiveStats) aliasField._positiveStats = { ...field._positiveStats };
      if (field._useLogScale != null) aliasField._useLogScale = field._useLogScale;
      if (field._useFilterColorRange != null) aliasField._useFilterColorRange = field._useFilterColorRange;
      if (field._filterEnabled != null) aliasField._filterEnabled = field._filterEnabled;
      if (field._outlierFilterEnabled != null) aliasField._outlierFilterEnabled = field._outlierFilterEnabled;
      if (field._outlierThreshold != null) aliasField._outlierThreshold = field._outlierThreshold;
      if (field._colormapId) aliasField._colormapId = field._colormapId;

      fields.push(aliasField);
      const newFieldIndex = fields.length - 1;

      getFieldRegistry().invalidate();
      this._syncActiveContext();
      this._notifyFieldChange(src, newFieldIndex, ChangeType.CREATE, { userDefinedId: created.id });

      return { newFieldIndex, newKey };
    }

    console.warn('[State] duplicateField: unsupported field kind:', field.kind);
    return null;
  }

  createCategoricalFromPages(options) {
    const result = this._userDefinedFields.createFromPages(options, this);

    if (result.field) {
      if (!this.obsData) this.obsData = { fields: [] };
      if (!this.obsData.fields) this.obsData.fields = [];

      this.obsData.fields.push(result.field);
      const newIndex = this.obsData.fields.length - 1;

      getFieldRegistry().invalidate();
      this._syncActiveContext();
      this._notifyFieldChange(FieldSource.OBS, newIndex, ChangeType.CREATE, { userDefinedId: result.id });
    }

    return result;
  }

  deleteUserDefinedField(fieldId, source = FieldSource.OBS) {
    const src = source === FieldSource.VAR ? FieldSource.VAR : FieldSource.OBS;
    const fields = src === FieldSource.VAR ? this.varData?.fields : this.obsData?.fields;
    const field = fields?.find?.((f) => f && f._userDefinedId === fieldId);
    if (!field) return false;

    // User-defined fields are fully owned by Cellucid and serialized via
    // UserDefinedFieldsRegistry. For dev-phase workflows we treat deletion as
    // a soft-delete so the user can restore derived columns (e.g. after
    // delete→unassigned or drag-merge operations).
    field._isDeleted = true;
    const template = this._userDefinedFields?.getField?.(fieldId);
    if (template) template._isDeleted = true;

    if (src === FieldSource.OBS && this.activeFieldSource === FieldSource.OBS && this.activeFieldIndex >= 0) {
      const active = this.obsData?.fields?.[this.activeFieldIndex];
      if (active && active._userDefinedId === fieldId) this.clearActiveField();
    }
    if (src === FieldSource.VAR && this.activeFieldSource === FieldSource.VAR && this.activeVarFieldIndex >= 0) {
      const active = this.varData?.fields?.[this.activeVarFieldIndex];
      if (active && active._userDefinedId === fieldId) this.clearActiveField();
    }

    getFieldRegistry().invalidate();
    this.computeGlobalVisibility();
    this.updateFilterSummary();
    const fieldIndex = fields?.indexOf(field) ?? -1;
    this._notifyFieldChange(src, fieldIndex, ChangeType.DELETE, { userDefinedId: fieldId, originalKey: field._originalKey || field.key });
    return true;
  }

  isUserDefinedField(source, fieldIndex) {
    if (source !== FieldSource.OBS) return false;
    const field = this.obsData?.fields?.[fieldIndex];
    return field?._isUserDefined === true;
  }

  _ensureActiveSelectionNotDeleted() {
    if (this.activeFieldSource === FieldSource.OBS && this.activeFieldIndex >= 0) {
      const field = this.obsData?.fields?.[this.activeFieldIndex];
      if (field?._isDeleted === true) {
        this.activeFieldIndex = -1;
        this.activeFieldSource = null;
      }
    }
    if (this.activeFieldSource === FieldSource.VAR && this.activeVarFieldIndex >= 0) {
      const field = this.varData?.fields?.[this.activeVarFieldIndex];
      if (field?._isDeleted === true) {
        this.activeVarFieldIndex = -1;
        this.activeFieldSource = null;
      }
    }
  }

  _applyOverlaysToFields(fields, source) {
    if (!fields || fields.length === 0) return;

    for (const field of fields) {
      if (!field) continue;
      if (field._isUserDefined === true && field._userDefinedId) {
        // User-defined fields are serialized with their current metadata.
        // Do not apply rename/delete/category overlays from registries.
        continue;
      }

      const originalKey = field._originalKey || field.key;
      if (!originalKey) continue;

      // Field rename overlay
      const displayKey = this._renameRegistry.getDisplayKey(source, originalKey);
      if (displayKey !== originalKey) {
        field._originalKey = originalKey;
        field.key = displayKey;
      } else if (field._originalKey) {
        // Registry says "no rename" -> restore original.
        field.key = originalKey;
        delete field._originalKey;
      }

      // Delete overlay
      if (this._deleteRegistry.isDeleted(source, originalKey)) {
        field._isDeleted = true;
      } else {
        delete field._isDeleted;
      }

      // Confirmed deletion (non-restorable)
      if (this._deleteRegistry.isPurged?.(source, originalKey)) {
        field._isPurged = true;
        field._isDeleted = true;
      } else {
        delete field._isPurged;
      }

      // Category rename overlay (only for categorical fields)
      if (field.kind === FieldKind.CATEGORY && Array.isArray(field.categories)) {
        // Reset categories back to originals if we have them.
        if (Array.isArray(field._originalCategories) && field._originalCategories.length === field.categories.length) {
          for (let i = 0; i < field.categories.length; i++) {
            field.categories[i] = field._originalCategories[i];
          }
        }

        // Apply registry renames.
        let hasAnyRename = false;
        for (let i = 0; i < field.categories.length; i++) {
          const originalLabel = field.categories[i];
          const displayLabel = this._renameRegistry.getDisplayCategory(source, originalKey, i, originalLabel);
          if (displayLabel !== originalLabel) {
            hasAnyRename = true;
          }
        }

        if (hasAnyRename && !Array.isArray(field._originalCategories)) {
          field._originalCategories = [...field.categories];
        }

        for (let i = 0; i < field.categories.length; i++) {
          const originalLabel = field._originalCategories?.[i] ?? field.categories[i];
          const displayLabel = this._renameRegistry.getDisplayCategory(source, originalKey, i, originalLabel);
          field.categories[i] = displayLabel;
          this._syncCentroidCategoryLabelAtIndex(field, i);
        }

        if (!hasAnyRename) {
          delete field._originalCategories;
        }
      }
    }
  }

  _injectUserDefinedFields() {
    this._injectUserDefinedFieldsForSource(FieldSource.OBS);
    this._injectUserDefinedFieldsForSource(FieldSource.VAR);
  }

  _injectUserDefinedFieldsForSource(source) {
    const src = source === FieldSource.VAR ? FieldSource.VAR : FieldSource.OBS;
    const fields = src === FieldSource.VAR ? this.varData?.fields : this.obsData?.fields;
    if (!fields) return;

    const existingIds = new Set();
    for (const field of fields) {
      if (field && field._isUserDefined && field._userDefinedId) {
        existingIds.add(field._userDefinedId);
      }
    }

    const templates = this._userDefinedFields.getAllFieldsForSource
      ? this._userDefinedFields.getAllFieldsForSource(src)
      : this._userDefinedFields.getAllFields();

    for (const template of templates) {
      if (!template || !template._userDefinedId) continue;
      if (existingIds.has(template._userDefinedId)) continue;

      // Clone the definition but keep heavy arrays shared (codes/centroidsByDim).
      const clone = { ...template };
      // Reset per-view UI/filter state so each view can diverge safely.
      delete clone._categoryColors;
      delete clone._categoryVisible;
      delete clone._continuousStats;
      delete clone._continuousFilter;
      delete clone._continuousColorRange;
      delete clone._categoryCounts;
      clone._loadingPromise = null;

      fields.push(clone);
    }
  }

  _syncCentroidCategoryLabelAtIndex(field, categoryIndex) {
    const nextLabel = field.categories?.[categoryIndex];
    if (!nextLabel) return;

    const byDim = field.centroidsByDim || {};
    for (const centroids of Object.values(byDim)) {
      if (!Array.isArray(centroids)) continue;
      const c = centroids[categoryIndex];
      if (c && typeof c === 'object') c.category = nextLabel;
    }
  }

  _refreshHighlightGroupsForField(source, fieldIndex) {
    for (const page of this.highlightPages || []) {
      for (const group of (page.highlightedGroups || [])) {
        if (!group) continue;
        if (group.fieldSource !== source) continue;
        if (group.fieldIndex !== fieldIndex) continue;

        const field = source === FieldSource.VAR
          ? this.varData?.fields?.[fieldIndex]
          : this.obsData?.fields?.[fieldIndex];
        if (!field) continue;

        group.fieldKey = field.key;

        if (group.type === 'category') {
          const label = field.categories?.[group.categoryIndex];
          if (label != null) group.categoryName = label;
          group.label = `${field.key}: ${group.categoryName}`;
        } else if (group.type === 'range') {
          const formatVal = (v) => {
            const num = Number(v);
            if (!Number.isFinite(num)) return String(v);
            if (Math.abs(num) >= 1000 || (Math.abs(num) > 0 && Math.abs(num) < 0.01)) return num.toExponential(2);
            return num.toFixed(2);
          };
          group.label = `${field.key}: ${formatVal(group.rangeMin)} – ${formatVal(group.rangeMax)}`;
        }
      }
    }

    this._notifyHighlightChange?.();
  }

  _ensureUserDefinedCentroidsForDim(field, dim) {
    if (!field || field._isUserDefined !== true || !field._userDefinedId) return;

    const dimKey = String(dim);
    const centroidsByDim = field.centroidsByDim || {};
    if (centroidsByDim[dimKey] || centroidsByDim[dim]) return;

    const rawPositions = this.dimensionManager?.positionCache?.get?.(dim);
    if (!rawPositions) return;

    this._userDefinedFields.recomputeCentroidsForDimension(field._userDefinedId, dim, rawPositions);

    // The new centroids are raw; make sure they are normalized exactly once when rendered.
    if (field._normalizedDims instanceof Set) {
      field._normalizedDims.delete(dimKey);
    }
  }

  /**
   * Get the active field for a specific view (without switching to it).
   * Returns null if viewId is invalid or has no active field.
   */
  getFieldForView(viewId) {
    const key = String(viewId || 'live');
    if (key === String(this.activeViewId)) {
      return this.getActiveField();
    }
    const ctx = this.viewContexts.get(key);
    if (!ctx) return null;
    const source = ctx.activeFieldSource;
    if (source === 'var') {
      const varFields = ctx.varData?.fields || [];
      const idx = ctx.activeVarFieldIndex ?? -1;
      return idx >= 0 ? varFields[idx] : null;
    }
    const obsFields = ctx.obsData?.fields || [];
    const idx = ctx.activeFieldIndex ?? -1;
    return idx >= 0 ? obsFields[idx] : null;
  }

  /**
   * Get the filter summary for a specific view (without switching to it).
   */
  getFilterSummaryForView(viewId) {
    const key = String(viewId || 'live');
    if (key === String(this.activeViewId)) {
      return this.getFilterSummaryLines();
    }
    const ctx = this.viewContexts.get(key);
    if (!ctx || !ctx.obsData || !ctx.obsData.fields) return [];

    const filters = [];
    const fields = ctx.obsData.fields;

    for (let fi = 0; fi < fields.length; fi++) {
      const field = fields[fi];
      if (!field) continue;
      if (field._isDeleted === true) continue;
      const fieldKey = field.key || `Field ${fi + 1}`;

      // Check continuous filter
      if (field.kind === 'continuous' && field._continuousStats && field._continuousFilter) {
        const stats = field._continuousStats;
        const filter = field._continuousFilter;
        const fullRange = filter.min <= stats.min + 1e-6 && filter.max >= stats.max - 1e-6;
        if (!fullRange && field._filterEnabled !== false) {
          filters.push(`${fieldKey}: ${filter.min.toFixed(2)} – ${filter.max.toFixed(2)}`);
        }
      }

      // Check category filter
      if (field.kind === 'category') {
        const categories = field.categories || [];
        const visibleMap = field._categoryVisible || {};
        const hiddenNames = [];
        for (let i = 0; i < categories.length; i++) {
          if (visibleMap[i] === false) {
            hiddenNames.push(String(categories[i]));
          }
        }
        if (hiddenNames.length > 0 && field._categoryFilterEnabled !== false) {
          const preview = hiddenNames.slice(0, 2).join(', ');
          const extra = hiddenNames.length > 2 ? ` +${hiddenNames.length - 2}` : '';
          filters.push(`${fieldKey}: hiding ${preview}${extra}`);
        }
      }
    }

    return filters.length > 0 ? filters : ['No filters active'];
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

  /**
   * Ensure a field is loaded before use.
   * @param {number} fieldIndex - Index of the field in obsData.fields
   * @param {Object} [options] - Options
   * @param {boolean} [options.silent=false] - If true, suppress notifications (for batch operations)
   * @returns {Promise<Object>} The loaded field object
   */
  async ensureFieldLoaded(fieldIndex, options = {}) {
    const { silent = false } = options;
    const field = this.obsData?.fields?.[fieldIndex];
    if (!field) throw new Error(`Obs field ${fieldIndex} is not available.`);
    const cacheKey = field._originalKey || field.key || String(fieldIndex);

    // User-defined continuous aliases are materialized by copying from their source field.
    if (
      field.loaded !== true &&
      field._isUserDefined === true &&
      field._userDefinedId &&
      field.kind === FieldKind.CONTINUOUS &&
      field._sourceField?.sourceKey
    ) {
      const sourceKey = String(field._sourceField.sourceKey || '').trim();
      const sourceIndex = sourceKey ? getFieldRegistry().getIndexByKey(FieldSource.OBS, sourceKey) : -1;
      if (sourceIndex < 0) {
        throw new Error(`Source field not found for "${field.key}" (sourceKey="${sourceKey}")`);
      }

      const sourceField = await this.ensureFieldLoaded(sourceIndex, options);
      const values = sourceField?.values;
      if (!values || typeof values.length !== 'number') {
        throw new Error(`Source field "${sourceKey}" has no values to copy`);
      }

      field.values = typeof values.slice === 'function' ? values.slice() : values;
      if (sourceField?.outlierQuantiles) field.outlierQuantiles = sourceField.outlierQuantiles;
      field.loaded = true;
      field._loadingPromise = null;
      this._fieldDataCache.set(cacheKey, { values: field.values, outlierQuantiles: field.outlierQuantiles });
      return field;
    }

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

    // Show loading notification (unless silent mode for batch operations)
    const notifications = getNotificationCenter();
    const notifId = silent ? null : notifications.loading(`Loading field: ${field.key}`, { category: 'data' });

    // If the field has been renamed, keep network/data lookups stable by loading using the original key.
    const loaderField = field._originalKey ? { ...field, key: field._originalKey } : field;

    field._loadingPromise = this.fieldLoader(loaderField)
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
        if (notifId) notifications.complete(notifId, `Loaded field: ${field.key}`);
        return field;
      })
      .catch((err) => {
        field._loadingPromise = null;
        if (notifId) notifications.fail(notifId, `Failed to load field: ${field.key}`);
        throw err;
      });

    return field._loadingPromise;
  }

  /**
   * Ensure a var field (gene) is loaded before use.
   * @param {number} fieldIndex - Index of the field in varData.fields
   * @param {Object} [options] - Options
   * @param {boolean} [options.silent=false] - If true, suppress notifications (for batch operations)
   * @returns {Promise<Object>} The loaded field object
   */
  async ensureVarFieldLoaded(fieldIndex, options = {}) {
    const { silent = false } = options;
    const field = this.varData?.fields?.[fieldIndex];
    if (!field) throw new Error(`Var field ${fieldIndex} is not available.`);
    const cacheKey = field._originalKey || field.key || String(fieldIndex);

    // User-defined continuous aliases (gene copies) are materialized by copying from their source gene.
    if (
      field.loaded !== true &&
      field._isUserDefined === true &&
      field._userDefinedId &&
      field.kind === FieldKind.CONTINUOUS &&
      field._sourceField?.sourceKey
    ) {
      const sourceKey = String(field._sourceField.sourceKey || '').trim();
      const sourceIndex = sourceKey ? getFieldRegistry().getIndexByKey(FieldSource.VAR, sourceKey) : -1;
      if (sourceIndex < 0) {
        throw new Error(`Source gene not found for "${field.key}" (sourceKey="${sourceKey}")`);
      }

      const sourceField = await this.ensureVarFieldLoaded(sourceIndex, options);
      const values = sourceField?.values;
      if (!values || typeof values.length !== 'number') {
        throw new Error(`Source gene "${sourceKey}" has no values to copy`);
      }

      field.values = typeof values.slice === 'function' ? values.slice() : values;
      field.loaded = true;
      field._loadingPromise = null;
      this._varFieldDataCache.set(cacheKey, { values: field.values });
      return field;
    }

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

    // Show loading notification for gene expression (unless silent mode for batch operations)
    const notifications = getNotificationCenter();
    const notifId = silent ? null : notifications.loading(`Loading gene: ${field.key}`, { category: 'data' });

    // If the gene has been renamed, load using the original key for stable lookups.
    const loaderField = field._originalKey ? { ...field, key: field._originalKey } : field;

    field._loadingPromise = this.varFieldLoader(loaderField)
      .then((loadedData) => {
        if (loadedData?.values) field.values = loadedData.values;
        if (field.values && field.values.length !== this.pointCount) {
          throw new Error(`Var field "${field.key}" values length mismatch (${field.values.length} vs ${this.pointCount}).`);
        }
        field.loaded = true;
        field._loadingPromise = null;
        this._varFieldDataCache.set(cacheKey, { values: field.values });
        if (notifId) notifications.complete(notifId, `Loaded gene: ${field.key}`);
        return field;
      })
      .catch((err) => {
        field._loadingPromise = null;
        if (notifId) notifications.fail(notifId, `Failed to load gene: ${field.key}`);
        throw err;
      });

    return field._loadingPromise;
  }

  /**
   * Unload a var field (gene) to free memory.
   *
   * Note: Genes loaded for bulk analyses (e.g., differential expression) can otherwise
   * accumulate in memory because loaded arrays are referenced from `varData.fields`.
   *
   * @param {number} fieldIndex - Index of the field in varData.fields
   * @param {Object} [options]
   * @param {boolean} [options.preserveActive=true] - If true, do not unload an active gene field
   * @returns {boolean} True if unloaded
   */
  unloadVarField(fieldIndex, options = {}) {
    const { preserveActive = true } = options;

    if (!Number.isInteger(fieldIndex) || fieldIndex < 0) return false;

    const isActiveInCurrent =
      this.activeFieldSource === 'var' && this.activeVarFieldIndex === fieldIndex;

    if (preserveActive && isActiveInCurrent) {
      return false;
    }

    // If this field is active in any saved view context, optionally preserve it too.
    if (preserveActive) {
      for (const ctx of this.viewContexts.values()) {
        if (!ctx) continue;
        if (ctx.activeFieldSource === 'var' && ctx.activeVarFieldIndex === fieldIndex) {
          return false;
        }
      }
    }

    const field = this.varData?.fields?.[fieldIndex];
    if (!field) return false;

    const cacheKey = field._originalKey || field.key || String(fieldIndex);

    // Clear LRU reference first so it doesn't keep the ArrayBuffer alive.
    this._varFieldDataCache?.delete?.(cacheKey);

    const clearFieldState = (f) => {
      if (!f) return;
      f.values = null;
      f.loaded = false;
      f._loadingPromise = null;
    };

    // Clear from current varData
    clearFieldState(field);

    // Clear from all stored view contexts (they clone field objects but may share values refs)
    for (const ctx of this.viewContexts.values()) {
      const ctxField = ctx?.varData?.fields?.[fieldIndex];
      if (!ctxField) continue;
      if ((ctxField.key || String(fieldIndex)) === cacheKey) {
        clearFieldState(ctxField);
      }
    }

    // If the gene was active and we were asked to unload anyway, reset active state.
    if (isActiveInCurrent && !preserveActive && typeof this.clearActiveField === 'function') {
      try {
        this.clearActiveField();
      } catch (err) {
        console.warn('[DataState] Failed to clear active field after unload:', err);
      }
    }

    return true;
  }

  setActiveField(fieldIndex) {
    const nextField = this.obsData?.fields?.[fieldIndex];
    if (!nextField || nextField._isDeleted === true) return null;
    this.activeFieldIndex = fieldIndex;
    this.activeVarFieldIndex = -1;
    this.activeFieldSource = 'obs';
    const field = nextField;
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
    this._pushActiveViewLabelToViewer();

    const currentCentroids = this._getCentroidsForCurrentDim(field);
    const centroidInfo =
      field.kind === 'category' && currentCentroids.length > 0 ? ` • Centroids: ${currentCentroids.length}` : '';
    return {
      field,
      pointCount: this.pointCount,
      centroidInfo
    };
  }

  setActiveVarField(fieldIndex) {
    const nextField = this.varData?.fields?.[fieldIndex];
    if (!nextField || nextField._isDeleted === true) return null;
    this.activeVarFieldIndex = fieldIndex;
    this.activeFieldIndex = -1;
    this.activeFieldSource = 'var';
    const field = nextField;
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
    this._pushActiveViewLabelToViewer();

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
      if (field?._isDeleted === true) continue;
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
    const applyOutlierFilter = this.isOutlierFilterEnabledForActiveField();
    const threshold = applyOutlierFilter ? this.getCurrentOutlierThreshold() : 1.0;
    const outliers = applyOutlierFilter ? (this.outlierQuantilesArray || []) : [];
    const alpha = this.categoryTransparency || [];
    let shown = 0;
    for (let i = 0; i < total; i++) {
      const visible = (alpha[i] ?? 0) > 0.001;
      if (!visible) continue;
      // Only apply outlier filter when supported by the active field.
      if (applyOutlierFilter) {
        const q = outliers[i] ?? -1;
        if (q >= 0 && q > threshold) continue;
      }
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
    const applyOutlierFilter = this.isOutlierFilterEnabledForActiveField();
    const outliers = applyOutlierFilter ? (this.outlierQuantilesArray || []) : [];
    const threshold = applyOutlierFilter ? this.getCurrentOutlierThreshold() : 1.0;
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
      // Only apply outlier filter when supported by the active field.
      if (baseVisible && applyOutlierFilter) {
        const q = outliers[i] ?? -1;
        if (q >= 0 && q > threshold) {
          baseVisible = false;
        }
      }
      if (baseVisible) available[code]++;

      // Current visibility already encoded in alpha + outliers
      const isVisibleNow = (alpha[i] ?? 0) > 0.001;
      if (!isVisibleNow) continue;
      // Only apply outlier filter when supported by the active field.
      if (applyOutlierFilter) {
        const qNow = outliers[i] ?? -1;
        if (qNow >= 0 && qNow > threshold) continue;
      }
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
    const applyOutlierFilter = this.isOutlierFilterEnabledForActiveField();
    const outliers = applyOutlierFilter ? (this.outlierQuantilesArray || []) : [];
    const threshold = applyOutlierFilter ? this.getCurrentOutlierThreshold() : 1.0;
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

      // Outliers only apply if the outlier filter is enabled
      if (applyOutlierFilter) {
        const q = outliers[i] ?? -1;
        if (q >= 0 && q > threshold) continue;
      }

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
    const centroids = this._getCentroidsForCurrentDim(field);
    if (centroids.length === 0 || !this.centroidColors) return false;
    const categories = field.categories || [];
    const visibleCounts = counts?.visible || [];
    const catIndexByName = new Map();
    categories.forEach((cat, idx) => catIndexByName.set(String(cat), idx));
    let changed = false;
    for (let i = 0; i < centroids.length; i++) {
      const c = centroids[i];
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

  buildCentroidsForField(field, { viewId = null } = {}) {
    // Get dimension-specific centroids based on current dimension level
    const currentDim = this.activeDimensionLevel || 3;
    const centroidsByDim = field.centroidsByDim || {};

    // Get centroids for current dimension
    let centroids = centroidsByDim[String(currentDim)]
      || centroidsByDim[currentDim]
      || [];

    // Lazy normalization: normalize centroids for this dimension if not already done.
    // Each dimension has its own normalization transform, so we track per-dimension.
    // This ensures centroids are correctly positioned regardless of which dimension
    // was loaded first or when switching between dimensions.
    //
    // centroidsByDim: per-dimension arrays, each normalized with its own transform
    if (centroids.length > 0 && this.dimensionManager) {
      // Initialize normalization tracking map if needed
      if (!field._normalizedDims) {
        field._normalizedDims = new Set();
      }

      const dimKey = String(currentDim);

      // Check if this centroid array needs normalization
      if (!field._normalizedDims.has(dimKey)) {
        const normTransform = this.dimensionManager.getNormTransform(currentDim);

        if (normTransform) {
          const { center, scale } = normTransform;
          const [cx, cy, cz] = center;

          // Normalize each centroid's position in-place
          for (const c of centroids) {
            const p = c.position;
            if (!p) continue;
            // Handle 1D, 2D, and 3D positions
            if (p.length >= 1) p[0] = (p[0] - cx) * scale;
            if (p.length >= 2) p[1] = (p[1] - cy) * scale;
            if (p.length >= 3) p[2] = (p[2] - cz) * scale;
          }

          // Mark as normalized
          field._normalizedDims.add(dimKey);
        }
      }
    }

    // Determine the native dimension of these centroids (from position array length)
    let nativeDim = 3;
    if (centroids.length > 0 && centroids[0].position) {
      nativeDim = centroids[0].position.length;
    }

    const categories = field.categories || [];
    this.ensureCategoryMetadata(field);
    const catColors = field._categoryColors || [];
    // Use provided viewId or fall back to activeViewId
    const viewKey = String(viewId || this.activeViewId || 'live');
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
    // Only compute and save counts when building for the active view, as
    // computeCategoryCountsForField uses active view's transparency/filters
    const isActiveView = viewKey === String(this.activeViewId);
    if (isActiveView) {
      const counts = this.computeCategoryCountsForField(field);
      if (counts) {
        field._categoryCounts = counts;
        this._activeCategoryCounts = counts;
      }
    }

    for (let i = 0; i < centroids.length; i++) {
      const c = centroids[i];
      const pos = c.position || [0, 0, 0];

      // Pad lower-dimensional positions to 3D for rendering
      // 1D: [x] -> [x, 0, 0]
      // 2D: [x, y] -> [x, y, 0]
      // 3D: [x, y, z] -> [x, y, z]
      this.centroidPositions[3 * i] = pos[0] || 0;
      this.centroidPositions[3 * i + 1] = nativeDim >= 2 ? (pos[1] || 0) : 0;
      this.centroidPositions[3 * i + 2] = nativeDim >= 3 ? (pos[2] || 0) : 0;

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

      // Store 3D position for labels
      const pos3D = [
        this.centroidPositions[3 * i],
        this.centroidPositions[3 * i + 1],
        this.centroidPositions[3 * i + 2]
      ];

      if (allowLabels && this.labelLayer) {
        const el = document.createElement('div');
        el.className = 'centroid-label';
        el.dataset.viewId = viewKey;
        el.textContent = String(c.category);
        this.labelLayer.appendChild(el);
        this.centroidLabels.push({ el, position: pos3D });
      }
    }
    if (typeof this.viewer.setCentroidLabels === 'function') {
      this.viewer.setCentroidLabels(this.centroidLabels, viewKey);
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

  /**
   * Outlier filtering is only applicable when the active field provides
   * `outlierQuantiles` (latent-space outlier stats).
   *
   * User-defined categoricals never have these stats, so this prevents
   * outlier filtering from being applied "silently" when the UI control is hidden.
   * @returns {boolean}
   */
  isOutlierFilterEnabledForActiveField() {
    const field = this.getActiveField?.();
    if (!field || !field.outlierQuantiles || !field.outlierQuantiles.length) return false;
    if (field._outlierFilterEnabled === false) return false;
    const threshold = field._outlierThreshold != null ? field._outlierThreshold : 1.0;
    return threshold < 0.9999;
  }

  getCurrentOutlierThreshold() {
    const field = this.getActiveField();
    if (field && field._outlierThreshold != null) return field._outlierThreshold;
    return 1.0;
  }

  computeGlobalVisibility() {
    if (!this.obsData || !this.obsData.fields || !this.pointCount) return;
    const fields = this.obsData.fields;
    const activeVarCandidate = (this.activeFieldSource === 'var' && this.activeVarFieldIndex >= 0)
      ? this.varData?.fields?.[this.activeVarFieldIndex]
      : null;
    const activeVarField = activeVarCandidate && activeVarCandidate._isDeleted !== true ? activeVarCandidate : null;
    const activeVarValues = activeVarField?.values || [];
    if (!this.categoryTransparency || this.categoryTransparency.length !== this.pointCount) {
      this.categoryTransparency = new Float32Array(this.pointCount);
    }

    const applyOutlierFilter = this.isOutlierFilterEnabledForActiveField();
    const outlierThreshold = applyOutlierFilter ? this.getCurrentOutlierThreshold() : 1.0;
    const outliers = applyOutlierFilter ? (this.outlierQuantilesArray || []) : [];

    for (let i = 0; i < this.pointCount; i++) {
      let visible = true;
      for (let f = 0; f < fields.length; f++) {
        const field = fields[f];
        if (!field) continue;
        if (field._isDeleted === true) continue;
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
      // Apply outlier filter for the active field (only when supported).
      if (visible && applyOutlierFilter) {
        const q = (i < outliers.length) ? outliers[i] : -1;
        if (q >= 0 && q > outlierThreshold) visible = false;
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
    // Human-readable filter summaries (used for view labels + sidebar summary).
    const filters = this.getActiveFiltersStructured();
    if (filters.length === 0) return ['No filters active'];
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
      if (field._isDeleted === true) continue;
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
          const disabledSuffix = enabled ? '' : ' (disabled)';
          filters.push({
            id: `obs-continuous-${fi}`,
            type: 'continuous',
            source: 'obs',
            fieldIndex: fi,
            fieldKey: key,
            enabled: enabled,
            text: `${key}: ${filter.min.toFixed(2)} – ${filter.max.toFixed(2)}${disabledSuffix}`
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
          const disabledSuffix = enabled ? '' : ' (disabled)';
          filters.push({
            id: `obs-category-${fi}`,
            type: 'category',
            source: 'obs',
            fieldIndex: fi,
            fieldKey: key,
            enabled: enabled,
            hiddenCount: hiddenNames.length,
            text: `${key}: hiding ${preview}${extra}${disabledSuffix}`
          });
        }
        
        // Outlier filter
        if (field.outlierQuantiles && field.outlierQuantiles.length) {
          const threshold = field._outlierThreshold != null ? field._outlierThreshold : 1.0;
          if (threshold < 0.9999) {
            const enabled = field._outlierFilterEnabled !== false; // default true
            const pct = Math.round(threshold * 100);
            const disabledSuffix = enabled ? '' : ' (disabled)';
            filters.push({
              id: `obs-outlier-${fi}`,
              type: 'outlier',
              source: 'obs',
              fieldIndex: fi,
              fieldKey: key,
              enabled: enabled,
              text: `${key}: outlier ≤ ${pct}%${disabledSuffix}`
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
      if (field && field._isDeleted !== true && field.kind === 'continuous' && field._continuousStats && field._continuousFilter) {
        const stats = field._continuousStats;
        const filter = field._continuousFilter;
        const fullRange =
          filter.min <= stats.min + 1e-6 &&
          filter.max >= stats.max - 1e-6;
        if (!fullRange) {
          const enabled = field._filterEnabled !== false; // default true
          const disabledSuffix = enabled ? '' : ' (disabled)';
          filters.push({
            id: `var-continuous-${this.activeVarFieldIndex}`,
            type: 'continuous',
            source: 'var',
            fieldIndex: this.activeVarFieldIndex,
            fieldKey: field.key,
            enabled: enabled,
            text: `${field.key}: ${filter.min.toFixed(2)} – ${filter.max.toFixed(2)}${disabledSuffix}`
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
    this._reapplyCategoryColorsNoRecompute(field);
    // Let computeGlobalVisibility handle transparency/filtering
    this.computeGlobalVisibility();
  }

  /**
   * Update color array for a category field without triggering visibility recomputation.
   * Used by batch mode to defer the expensive computeGlobalVisibility() call.
   */
  _reapplyCategoryColorsNoRecompute(field) {
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
    if (this._batchMode) {
      this._batchDirty.colors = true;
      this._batchDirty.affectedFields.add(field);
    } else {
      this.reapplyCategoryColors(field);
    }
  }

  setVisibilityForCategory(field, idx, visible) {
    this.ensureCategoryMetadata(field);
    field._categoryVisible[idx] = visible;
    if (this._batchMode) {
      this._batchDirty.visibility = true;
      this._batchDirty.colors = true; // visibility changes affect color display
      this._batchDirty.affectedFields.add(field);
    } else {
      this.reapplyCategoryColors(field);
    }
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
      filtersText,
      dimensionLevel: this.activeDimensionLevel // Include dimension level for Keep View
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

  // Convenience alias: highlighted groups for the active page.
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

  /**
   * Get the unique highlighted cell count for a page (enabled groups only).
   * Used by both the Highlighted Cells UI and analysis selectors.
   * @param {string} pageId
   * @returns {number}
   */
  getHighlightedCellCountForPage(pageId) {
    const page = this.highlightPages.find((p) => p.id === pageId);
    if (!page) return 0;

    const indices = new Set();
    for (const group of (page.highlightedGroups || [])) {
      if (!group || group.enabled === false) continue;
      const cells = group.cellIndices || [];
      for (let i = 0; i < cells.length; i++) indices.add(cells[i]);
    }
    return indices.size;
  }

  createHighlightPage(name = null) {
    const id = `page_${++this._highlightPageIdCounter}`;
    const pageName = name || `Page ${this.highlightPages.length + 1}`;
    const page = {
      id,
      name: pageName,
      color: getPageColor(this.highlightPages.length),
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
   * Set a persistent color for a highlight page.
   * This is used across the app (Highlighted Cells tabs + analysis UI).
   *
   * @param {string} pageId
   * @param {string} color - Hex color (#RRGGBB)
   * @returns {boolean}
   */
  setHighlightPageColor(pageId, color) {
    const page = this.highlightPages.find((p) => p.id === pageId);
    if (!page) return false;

    const next = String(color ?? '').trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(next)) {
      console.warn('[State] Invalid page color:', color);
      return false;
    }

    page.color = next;
    this._notifyHighlightPageChange();
    return true;
  }

  /**
   * Get the current color for a page (falls back to the default palette).
   * @param {string} pageId
   * @returns {string}
   */
  getHighlightPageColor(pageId) {
    const page = this.highlightPages.find((p) => p.id === pageId);
    if (page?.color) return page.color;
    const idx = this.highlightPages.findIndex((p) => p.id === pageId);
    return getPageColor(idx >= 0 ? idx : 0);
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
    this._invalidateHighlightCountCache(); // Invalidate cached counts
    this.highlightArray.fill(0);

    // Collect all highlighted indices as we go (avoids O(n) scan in renderer)
    const allHighlightedIndices = [];

    for (const group of this.highlightedGroups) {
      // Skip disabled groups
      if (group.enabled === false) continue;
      const indices = group.cellIndices;
      if (!indices) continue;
      for (let i = 0; i < indices.length; i++) {
        const idx = indices[i];
        if (idx >= 0 && idx < this.pointCount) {
          // Only add if not already highlighted (avoid duplicates)
          if (this.highlightArray[idx] === 0) {
            this.highlightArray[idx] = 255;
            allHighlightedIndices.push(idx);
          }
        }
      }
    }

    this._pushHighlightToViewer(allHighlightedIndices);
  }

  _pushHighlightToViewer(highlightedIndices = null) {
    if (this.viewer && typeof this.viewer.updateHighlight === 'function') {
      this.viewer.updateHighlight(this.highlightArray, highlightedIndices);
    }
  }

  /**
   * Get cell indices for a categorical selection.
   * Only includes cells that are currently visible (pass all active filters).
   * @param {number} fieldIndex - Field index in obs/var data
   * @param {number} categoryIndex - Category index to match
   * @param {string} [source='obs'] - Data source ('obs' or 'var')
   * @param {Float32Array} [viewTransparency] - Optional per-view transparency array.
   *   If provided, uses this for filtering instead of state.categoryTransparency.
   *   This allows selections to respect view-specific filters in multi-view mode.
   * @returns {number[]} Array of cell indices matching the category and passing filters
   */
  getCellIndicesForCategory(fieldIndex, categoryIndex, source = 'obs', viewTransparency = null) {
    const field = source === 'var'
      ? this.varData?.fields?.[fieldIndex]
      : this.obsData?.fields?.[fieldIndex];
    if (!field || field.kind !== 'category') return [];
    const codes = field.codes || [];
    const indices = [];
    // Use provided viewTransparency if available, otherwise fall back to state transparency
    const transparency = viewTransparency || this.categoryTransparency;
    for (let i = 0; i < codes.length; i++) {
      if (codes[i] === categoryIndex) {
        // Only include cells that are currently visible (not filtered out in the target view)
        const isVisible = !transparency || transparency[i] > 0;
        if (isVisible) {
          indices.push(i);
        }
      }
    }
    return indices;
  }

  /**
   * Get cell indices for a continuous range selection.
   * Only includes cells that are currently visible (pass all active filters).
   * @param {number} fieldIndex - Field index in obs/var data
   * @param {number} minVal - Minimum value for range
   * @param {number} maxVal - Maximum value for range
   * @param {string} [source='obs'] - Data source ('obs' or 'var')
   * @param {Float32Array} [viewTransparency] - Optional per-view transparency array.
   *   If provided, uses this for filtering instead of state.categoryTransparency.
   *   This allows selections to respect view-specific filters in multi-view mode.
   * @returns {number[]} Array of cell indices within range and passing filters
   */
  getCellIndicesForRange(fieldIndex, minVal, maxVal, source = 'obs', viewTransparency = null) {
    const field = source === 'var'
      ? this.varData?.fields?.[fieldIndex]
      : this.obsData?.fields?.[fieldIndex];
    if (!field || field.kind !== 'continuous') return [];
    const values = field.values || [];
    const indices = [];
    // Use provided viewTransparency if available, otherwise fall back to state transparency
    const transparency = viewTransparency || this.categoryTransparency;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v !== null && !Number.isNaN(v) && v >= minVal && v <= maxVal) {
        // Only include cells that are currently visible (not filtered out in the target view)
        const isVisible = !transparency || transparency[i] > 0;
        if (isVisible) {
          indices.push(i);
        }
      }
    }
    return indices;
  }

  // Clear preview highlight (restore to only permanent highlights)
  clearPreviewHighlight() {
    this._recomputeHighlightArray();
  }

  // Set a preview highlight from an array of cell indices (used for lasso preview)
  setPreviewHighlightFromIndices(cellIndices) {
    if (!cellIndices || cellIndices.length === 0) {
      this.clearPreviewHighlight();
      return;
    }

    this._ensureHighlightArray();
    // Start with existing permanent highlights
    this.highlightArray.fill(0);

    // Collect all highlighted indices (avoids O(n) scan in renderer)
    const allHighlightedIndices = [];

    for (const group of this.highlightedGroups) {
      if (group.enabled === false) continue;
      const indices = group.cellIndices;
      if (!indices) continue;
      for (let i = 0; i < indices.length; i++) {
        const idx = indices[i];
        if (idx >= 0 && idx < this.pointCount && this.highlightArray[idx] === 0) {
          this.highlightArray[idx] = 255;
          allHighlightedIndices.push(idx);
        }
      }
    }
    // Add preview highlights on top
    for (let i = 0; i < cellIndices.length; i++) {
      const idx = cellIndices[i];
      if (idx >= 0 && idx < this.pointCount && this.highlightArray[idx] === 0) {
        this.highlightArray[idx] = 255;
        allHighlightedIndices.push(idx);
      }
    }
    this._pushHighlightToViewer(allHighlightedIndices);
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

  // Add a highlight group directly with pre-computed cell indices
  // Used for state restoration where we have the exact cell indices
  addHighlightDirect(groupData) {
    if (!groupData || !groupData.cellIndices || groupData.cellIndices.length === 0) {
      return null;
    }

    const id = `highlight_${++this._highlightIdCounter}`;
    const group = {
      id,
      type: groupData.type || 'combined',
      label: groupData.label || `Restored selection (${groupData.cellIndices.length} cells)`,
      fieldKey: groupData.fieldKey,
      fieldIndex: groupData.fieldIndex,
      fieldSource: groupData.fieldSource || 'obs',
      cellIndices: Array.isArray(groupData.cellIndices) ? groupData.cellIndices : Array.from(groupData.cellIndices),
      cellCount: groupData.cellIndices.length,
      enabled: groupData.enabled !== false
    };

    // Add type-specific fields
    if (groupData.type === 'category') {
      group.categoryIndex = groupData.categoryIndex;
      group.categoryName = groupData.categoryName;
    } else if (groupData.type === 'range') {
      group.rangeMin = groupData.rangeMin;
      group.rangeMax = groupData.rangeMax;
    }

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
    this.highlightedGroups = [];
    this._recomputeHighlightArray();
    this._notifyHighlightChange();
  }

  getHighlightedGroups() {
    return this.highlightedGroups;
  }

  getHighlightedCellCount() {
    // Returns count of highlighted cells that are currently visible (cached)
    if (!this.highlightArray) return 0;
    const lodVisibility = this.viewer?.getLodVisibilityArray ? this.viewer.getLodVisibilityArray() : null;
    const lodLevel = this.viewer?.getCurrentLODLevel ? this.viewer.getCurrentLODLevel() : -1;
    const lodSignature = lodVisibility ? (lodLevel ?? -1) : -1;

    if (this._cachedHighlightCount !== null && this._cachedHighlightLodLevel === lodSignature) {
      return this._cachedHighlightCount;
    }

    let count = 0;
    for (let i = 0; i < this.highlightArray.length; i++) {
      if (this.highlightArray[i] > 0) {
        // Only count if visible (no transparency = visible, or transparency > 0)
        const visibleByAlpha = !this.categoryTransparency || this.categoryTransparency[i] > 0;
        const visibleByLod = !lodVisibility || lodVisibility[i] > 0;
        const isVisible = visibleByAlpha && visibleByLod;
        if (isVisible) count++;
      }
    }
    this._cachedHighlightCount = count;
    this._cachedHighlightLodLevel = lodSignature;
    return count;
  }

  getTotalHighlightedCellCount() {
    // Returns total count of all highlighted cells, including filtered-out ones (cached)
    if (!this.highlightArray) return 0;
    if (this._cachedTotalHighlightCount !== null) return this._cachedTotalHighlightCount;
    let count = 0;
    for (let i = 0; i < this.highlightArray.length; i++) {
      if (this.highlightArray[i] > 0) count++;
    }
    this._cachedTotalHighlightCount = count;
    return count;
  }

  // Invalidate highlight count caches (call when highlight array or visibility changes)
  _invalidateHighlightCountCache(visibleOnly = false) {
    this._cachedHighlightCount = null;
    this._cachedHighlightLodLevel = null;
    if (!visibleOnly) this._cachedTotalHighlightCount = null;
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
