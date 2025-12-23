/**
 * @fileoverview View Manager.
 *
 * Hosts view-context and dimension orchestration logic for DataState.
 *
 * @module state/managers/view-manager
 */

import { BaseManager } from '../core/base-manager.js';
import { viewContextCoreMethods } from './view-context-core.js';
import { viewContextViewerSyncMethods } from './view-context-viewer-sync.js';
import { getNotificationCenter } from '../../notification-center.js';
import { isAnnDataActive } from '../../../data/anndata-provider.js';

export class DataStateViewMethods {

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
   * Attach a vector field manager for dimension-specific per-cell displacement vectors
   * (e.g. scVelo velocity, CellRank drift vectors).
   *
   * The manager is optional: most datasets do not provide vector fields.
   *
   * @param {import('../../../data/vector-field-manager.js').VectorFieldManager | null} manager
   */
  setVectorFieldManager(manager) {
    this.vectorFieldManager = manager || null;
    this.emit?.('vectorFields:changed', this.getAvailableVectorFields?.() || []);
  }

  getVectorFieldManager() {
    return this.vectorFieldManager || null;
  }

  hasAnyVectorFields() {
    return Boolean(this.vectorFieldManager?.hasAny?.());
  }

  /**
   * @returns {{ id: string, label: string, availableDimensions: number[], defaultDimension: number }[]}
   */
  getAvailableVectorFields() {
    return this.vectorFieldManager?.getAvailableFields?.() || [];
  }

  /**
   * @returns {string|null}
   */
  getDefaultVectorFieldId() {
    return this.vectorFieldManager?.getDefaultFieldId?.() || null;
  }

  hasVectorField(fieldId) {
    const id = String(fieldId || '');
    if (!id) return false;
    return Boolean(this.vectorFieldManager?.hasField?.(id));
  }

  hasVectorFieldForDimension(fieldId, level) {
    const id = String(fieldId || '');
    if (!id) return false;
    return Boolean(this.vectorFieldManager?.hasFieldDimension?.(id, level));
  }

  /**
   * Ensure vector field data is loaded and uploaded to the viewer for a dimension.
   *
   * @param {string} fieldId
   * @param {number} level
   * @param {{ silent?: boolean }} [options]
   * @returns {Promise<boolean>}
   */
  async ensureVectorField(fieldId, level, options = {}) {
    const id = String(fieldId || '');
    const dim = Math.max(1, Math.min(3, Math.floor(level || 3)));
    if (!id) return false;
    if (!this.vectorFieldManager || !this.vectorFieldManager.hasFieldDimension?.(id, dim)) return false;
    if (!this.viewer?.setVectorFieldData) return false;
    if (this.viewer.hasVectorFieldForDimension?.(id, dim)) return true;

    const silent = options?.silent === true;
    const needsLocalNotif = typeof isAnnDataActive === 'function' ? isAnnDataActive() : false;
    const notifications = (!silent && needsLocalNotif) ? getNotificationCenter() : null;
    const label = this.vectorFieldManager.getAvailableFields().find((f) => f.id === id)?.label || id;
    const notifId = notifications?.loading?.(`Loading ${dim}D ${label}…`, { category: 'data' }) || null;

    try {
      const fieldData = await this.vectorFieldManager.loadField(id, dim, { showProgress: !silent && !needsLocalNotif });
      this.viewer.setVectorFieldData(id, dim, fieldData);
      notifications?.complete?.(notifId, `Loaded ${dim}D ${label}`);
      return true;
    } catch (err) {
      notifications?.fail?.(notifId, err?.message || `Failed to load ${dim}D ${label}`);
      throw err;
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

    // Serialize async dimension switches so concurrent callers can’t overlap across `await`.
    while (this._dimensionChangeLock) {
      await this._dimensionChangeLock;
    }

    let unlockDimensionChange = null;
    this._dimensionChangeLock = new Promise((resolve) => {
      unlockDimensionChange = resolve;
    });

    try {
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
    } finally {
      if (typeof unlockDimensionChange === 'function') {
        unlockDimensionChange();
      }
      this._dimensionChangeLock = null;
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
   * Notify listeners that the active view's dimension changed.
   * @private
   */
  _notifyDimensionChange() {
    const level = this.activeDimensionLevel;
    this.emit('dimension:changed', level);
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

}

Object.assign(DataStateViewMethods.prototype, viewContextCoreMethods, viewContextViewerSyncMethods);

export class ViewManager extends BaseManager {
  constructor(coordinator) {
    super(coordinator);
  }
}
