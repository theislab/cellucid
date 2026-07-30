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

const SUPPORTED_DIMENSIONS = new Set([1, 2, 3]);
export const DATASET_VIEW_LOAD_SUPERSEDED_CODE =
  'CELLUCID_DATASET_VIEW_LOAD_SUPERSEDED';

function requireDimensionLevel(level, label = 'Dimension') {
  if (!Number.isInteger(level) || !SUPPORTED_DIMENSIONS.has(level)) {
    throw new RangeError(`${label} must be exactly 1, 2, or 3.`);
  }
  return level;
}

function requireViewId(viewId) {
  if (typeof viewId !== 'string' || viewId.trim().length === 0) {
    throw new TypeError('Dimension view id must be a non-empty string.');
  }
  return viewId;
}

function requireDimensionChangeOptions(options) {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).length !== 1 ||
    !Object.hasOwn(options, 'viewId')
  ) {
    throw new TypeError(
      'Dimension options must contain exactly one "viewId".'
    );
  }
  return Object.freeze({ viewId: requireViewId(options.viewId) });
}

function requireMethod(owner, methodName, label) {
  if (
    owner === null ||
    typeof owner !== 'object' ||
    typeof owner[methodName] !== 'function'
  ) {
    throw new TypeError(`${label} must provide ${methodName}().`);
  }
}

function readDatasetGeneration(state) {
  const generation = state._datasetGeneration ?? 0;
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new TypeError(
      'DataState dataset generation must be a non-negative safe integer.'
    );
  }
  return generation;
}

function createDatasetViewLoadSupersededError(operation) {
  const error = new Error(
    `${operation} was superseded by a dataset or runtime-owner replacement.`
  );
  error.name = 'AbortError';
  error.code = DATASET_VIEW_LOAD_SUPERSEDED_CODE;
  return error;
}

export function isDatasetViewLoadSupersededError(error) {
  return error?.code === DATASET_VIEW_LOAD_SUPERSEDED_CODE;
}

function viewerIsTerminal(viewer) {
  if (typeof viewer.isDisposed !== 'function') return false;
  return viewer.isDisposed() !== false;
}

function assertCurrentDimensionLoadOwner(state, owner) {
  const ownerIsCurrent = (
    readDatasetGeneration(state) === owner.datasetGeneration
    && state.dimensionManager === owner.dimensionManager
    && state.viewer === owner.viewer
    && state.viewContexts === owner.viewContexts
    && owner.viewContexts.get(owner.targetViewId) === owner.context
    && state.pointCount === owner.pointCount
    && state.activeViewId === owner.activeViewId
    && owner.context.dimensionLevel === owner.previousLevel
    && !viewerIsTerminal(owner.viewer)
  );
  let currentField = null;
  if (ownerIsCurrent) {
    try {
      currentField = state.getFieldForView(owner.targetViewId);
    } catch {
      throw createDatasetViewLoadSupersededError(
        'Dimension coordinate loading'
      );
    }
  }
  if (!ownerIsCurrent || currentField !== owner.field) {
    throw createDatasetViewLoadSupersededError(
      'Dimension coordinate loading'
    );
  }
}

function assertCurrentVectorLoadOwner(state, owner) {
  if (
    readDatasetGeneration(state) !== owner.datasetGeneration
    || state.vectorFieldManager !== owner.vectorFieldManager
    || state.viewer !== owner.viewer
    || state.viewContexts !== owner.viewContexts
    || owner.viewContexts.get('live') !== owner.liveContext
    || state.pointCount !== owner.pointCount
    || viewerIsTerminal(owner.viewer)
  ) {
    throw createDatasetViewLoadSupersededError(
      'Vector-field loading'
    );
  }
}

function cloneCentroidState(owner) {
  return Object.freeze({
    positions: owner.centroidPositions === null
      ? null
      : new Float32Array(owner.centroidPositions),
    colors: owner.centroidColors === null
      ? null
      : new Uint8Array(owner.centroidColors),
    outliers: owner.centroidOutliers === null
      ? null
      : new Float32Array(owner.centroidOutliers),
    labels: owner.centroidLabels.map(label => (
      label === null ? null : { ...label }
    )),
  });
}

function requireStagedCentroids(owner, label) {
  if (
    !(owner.centroidPositions instanceof Float32Array) ||
    owner.centroidPositions.length % 3 !== 0 ||
    !(owner.centroidColors instanceof Uint8Array) ||
    owner.centroidColors.length !==
      (owner.centroidPositions.length / 3) * 4 ||
    !(owner.centroidOutliers instanceof Float32Array) ||
    owner.centroidOutliers.length !== owner.centroidPositions.length / 3 ||
    !Array.isArray(owner.centroidLabels)
  ) {
    throw new TypeError(`${label} produced incomplete centroid buffers.`);
  }
  return cloneCentroidState(owner);
}

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
    for (const methodName of [
      'getAvailableDimensions',
      'getDefaultDimension',
      'getPositions3D',
      'hasDimension',
      'setViewDimension',
    ]) {
      requireMethod(manager, methodName, 'Dimension manager');
    }
    const defaultDimension = requireDimensionLevel(
      manager.getDefaultDimension(),
      'Dimension manager default dimension'
    );
    const availableDimensions = manager.getAvailableDimensions();
    if (!Array.isArray(availableDimensions)) {
      throw new TypeError(
        'Dimension manager available dimensions must be an array.'
      );
    }
    let previousDimension = 0;
    for (const dimension of availableDimensions) {
      requireDimensionLevel(
        dimension,
        'Dimension manager available dimension'
      );
      if (dimension <= previousDimension) {
        throw new TypeError(
          'Dimension manager available dimensions must be strictly increasing.'
        );
      }
      previousDimension = dimension;
    }
    if (
      availableDimensions.length > 0 &&
      !availableDimensions.includes(defaultDimension)
    ) {
      throw new RangeError(
        'Dimension manager default dimension must be advertised as available.'
      );
    }
    this.dimensionManager = manager;
    this.activeDimensionLevel = defaultDimension;
    if (availableDimensions.includes(defaultDimension)) {
      manager.setViewDimension('live', defaultDimension);
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
    if (
      manager !== null &&
      (
        typeof manager !== 'object' ||
        typeof manager.hasAny !== 'function' ||
        typeof manager.getAvailableFields !== 'function' ||
        typeof manager.getDefaultFieldId !== 'function' ||
        typeof manager.hasField !== 'function' ||
        typeof manager.hasFieldDimension !== 'function' ||
        typeof manager.loadField !== 'function'
      )
    ) {
      throw new TypeError(
        'setVectorFieldManager requires null or the exact vector-field manager interface.'
      );
    }
    this.vectorFieldManager = manager;
    this.emit(
      'vectorFields:changed',
      manager === null ? [] : manager.getAvailableFields()
    );
  }

  getVectorFieldManager() {
    return this.vectorFieldManager;
  }

  hasAnyVectorFields() {
    return this.vectorFieldManager === null
      ? false
      : this.vectorFieldManager.hasAny();
  }

  /**
   * @returns {{ id: string, label: string, availableDimensions: number[], defaultDimension: number }[]}
   */
  getAvailableVectorFields() {
    return this.vectorFieldManager === null
      ? []
      : this.vectorFieldManager.getAvailableFields();
  }

  /**
   * @returns {string|null}
   */
  getDefaultVectorFieldId() {
    return this.vectorFieldManager === null
      ? null
      : this.vectorFieldManager.getDefaultFieldId();
  }

  hasVectorField(fieldId) {
    if (typeof fieldId !== 'string' || fieldId.length === 0) {
      throw new TypeError('Vector field id must be a non-empty string.');
    }
    return this.vectorFieldManager === null
      ? false
      : this.vectorFieldManager.hasField(fieldId);
  }

  hasVectorFieldForDimension(fieldId, level) {
    if (typeof fieldId !== 'string' || fieldId.length === 0) {
      throw new TypeError('Vector field id must be a non-empty string.');
    }
    if (!Number.isInteger(level) || level < 1 || level > 3) {
      throw new RangeError('Vector field dimension must be exactly 1, 2, or 3.');
    }
    return this.vectorFieldManager === null
      ? false
      : this.vectorFieldManager.hasFieldDimension(fieldId, level);
  }

  /**
   * Ensure vector field data is loaded and uploaded to the viewer for a dimension.
   *
   * @param {string} fieldId
   * @param {number} level
   * @param {{ silent: boolean }} options
   * @returns {Promise<boolean>}
   */
  async ensureVectorField(fieldId, level, options) {
    if (typeof fieldId !== 'string' || fieldId.length === 0) {
      throw new TypeError('Vector field id must be a non-empty string.');
    }
    if (!Number.isInteger(level) || level < 1 || level > 3) {
      throw new RangeError('Vector field dimension must be exactly 1, 2, or 3.');
    }
    if (
      options === null ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).length !== 1 ||
      !Object.hasOwn(options, 'silent') ||
      typeof options.silent !== 'boolean'
    ) {
      throw new TypeError(
        'ensureVectorField options must contain exactly one boolean "silent".'
      );
    }
    const vectorFieldManager = this.vectorFieldManager;
    const viewer = this.viewer;
    if (vectorFieldManager === null) {
      throw new Error('No vector-field manager is active.');
    }
    if (!vectorFieldManager.hasField(fieldId)) {
      throw new Error(`Unknown vector field "${fieldId}".`);
    }
    if (!vectorFieldManager.hasFieldDimension(fieldId, level)) {
      throw new Error(
        `Vector field "${fieldId}" does not declare ${level}D data.`
      );
    }
    if (
      viewer === null ||
      typeof viewer !== 'object' ||
      typeof viewer.setVectorFieldData !== 'function' ||
      typeof viewer.hasVectorFieldForDimension !== 'function'
    ) {
      throw new TypeError(
        'The active viewer must provide vector-field upload and query methods.'
      );
    }
    if (viewer.hasVectorFieldForDimension(fieldId, level)) return true;
    if (
      !(this.viewContexts instanceof Map) ||
      !this.viewContexts.has('live')
    ) {
      throw new TypeError(
        'Vector-field loading requires the exact live view context.'
      );
    }

    const silent = options.silent;
    const needsLocalNotif = isAnnDataActive();
    const notifications = (!silent && needsLocalNotif) ? getNotificationCenter() : null;
    const descriptor = vectorFieldManager
      .getAvailableFields()
      .find((field) => field.id === fieldId);
    if (descriptor === undefined) {
      throw new Error(
        `Vector field "${fieldId}" has no public field descriptor.`
      );
    }
    const notifId = notifications === null
      ? null
      : notifications.loading(
          `Loading ${level}D ${descriptor.label}…`,
          { category: 'data' }
        );

    const loadOwner = Object.freeze({
      datasetGeneration: readDatasetGeneration(this),
      liveContext: this.viewContexts.get('live'),
      pointCount: this.pointCount,
      vectorFieldManager,
      viewer,
      viewContexts: this.viewContexts,
    });
    try {
      const fieldData = await vectorFieldManager.loadField(
        fieldId,
        level,
        { showProgress: !silent && !needsLocalNotif }
      );
      assertCurrentVectorLoadOwner(this, loadOwner);
      viewer.setVectorFieldData(fieldId, level, fieldData);
      if (notifications !== null) {
        notifications.complete(notifId, `Loaded ${level}D ${descriptor.label}`);
      }
      return true;
    } catch (error) {
      if (notifications !== null) {
        if (isDatasetViewLoadSupersededError(error)) {
          notifications.dismiss(notifId);
        } else {
          const message = error instanceof Error
            ? error.message
            : `Vector field "${fieldId}" rejected with a non-Error value.`;
          notifications.fail(notifId, message);
        }
      }
      throw error;
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
   * @returns {number} Dimension level (1, 2, or 3)
   */
  getDimensionLevel() {
    return requireDimensionLevel(
      this.activeDimensionLevel,
      'Active dimension'
    );
  }

  /**
   * Get dimension level for a specific view
   * @param {string} viewId - View identifier
   * @returns {number} Dimension level (1, 2, or 3)
   */
  getViewDimensionLevel(viewId) {
    const targetViewId = requireViewId(viewId);
    if (!(this.viewContexts instanceof Map)) {
      throw new TypeError(
        'View dimension lookup requires the exact view-context map.'
      );
    }
    if (!this.viewContexts.has(targetViewId)) {
      throw new RangeError(`View "${targetViewId}" does not exist.`);
    }
    const context = this.viewContexts.get(targetViewId);
    if (
      context === null ||
      typeof context !== 'object' ||
      Array.isArray(context) ||
      context.id !== targetViewId
    ) {
      throw new TypeError(
        `View "${targetViewId}" has an invalid dimension context.`
      );
    }
    return requireDimensionLevel(
      context.dimensionLevel,
      `View "${targetViewId}" dimension`
    );
  }

  /**
   * Set one view to an available 1-D, 2-D, or 3-D embedding.
   * @param {number} level - Exact dimension level
   * @param {{ viewId: string }} options - Exact target view
   * @returns {Promise<void>}
   */
  async setDimensionLevel(level, options) {
    const nextLevel = requireDimensionLevel(level);
    const { viewId: targetViewId } =
      requireDimensionChangeOptions(options);

    // Serialize dimension transactions so their staged coordinates and
    // centroid buffers cannot overlap across an await boundary.
    while (this._dimensionChangeLock) {
      await this._dimensionChangeLock;
    }

    let unlockDimensionChange = null;
    this._dimensionChangeLock = new Promise((resolve) => {
      unlockDimensionChange = resolve;
    });

    try {
      const dimensionManager = this.dimensionManager;
      const viewer = this.viewer;
      for (const methodName of [
        'getPositions3D',
        'hasDimension',
        'setViewDimension',
      ]) {
        requireMethod(
          dimensionManager,
          methodName,
          'Dimension manager'
        );
      }
      requireMethod(this, 'getFieldForView', 'DataState');
      requireMethod(viewer, 'setViewDimension', 'Viewer');
      if (!(this.viewContexts instanceof Map)) {
        throw new TypeError(
          'Dimension changes require the exact view-context map.'
        );
      }
      if (!this.viewContexts.has(targetViewId)) {
        throw new RangeError(`View "${targetViewId}" does not exist.`);
      }
      const context = this.viewContexts.get(targetViewId);
      if (
        context === null ||
        typeof context !== 'object' ||
        Array.isArray(context) ||
        context.id !== targetViewId
      ) {
        throw new TypeError(
          `View "${targetViewId}" has an invalid dimension context.`
        );
      }
      const previousLevel = this.getViewDimensionLevel(targetViewId);
      const activeViewId = requireViewId(this.activeViewId);
      const isActiveView = targetViewId === activeViewId;
      const previousActiveLevel = this.getDimensionLevel();
      if (isActiveView && previousActiveLevel !== previousLevel) {
        throw new Error(
          `Active view "${targetViewId}" has inconsistent dimension state.`
        );
      }
      if (previousLevel === nextLevel) {
        return;
      }
      if (dimensionManager.hasDimension(nextLevel) !== true) {
        throw new RangeError(
          `Dimension ${nextLevel}D is not available in this dataset.`
        );
      }

      const isLiveView = targetViewId === 'live';
      if (isLiveView) {
        requireMethod(viewer, 'updatePositions', 'Viewer');
      } else {
        requireMethod(viewer, 'getViewPositions', 'Viewer');
        requireMethod(viewer, 'setViewPositions', 'Viewer');
      }

      const field = this.getFieldForView(targetViewId);
      if (
        field !== null &&
        (
          typeof field !== 'object' ||
          Array.isArray(field) ||
          !['category', 'continuous'].includes(field.kind)
        )
      ) {
        throw new TypeError(
          `View "${targetViewId}" has an invalid active field.`
        );
      }
      const hasCategoricalField =
        field !== null && field.kind === 'category';
      if (hasCategoricalField) {
        requireMethod(
          this,
          '_ensureUserDefinedCentroidsForDim',
          'DataState'
        );
        requireMethod(this, 'buildCentroidsForField', 'DataState');
        requireMethod(viewer, 'setCentroidLabels', 'Viewer');
        requireMethod(
          viewer,
          isLiveView ? 'setCentroids' : 'updateSnapshotAttributes',
          'Viewer'
        );
      }

      // Coordinates and derived centroid buffers are complete before any
      // dimension owner publishes the new level.
      const loadOwner = Object.freeze({
        activeViewId,
        context,
        datasetGeneration: readDatasetGeneration(this),
        dimensionManager,
        field,
        pointCount: this.pointCount,
        previousLevel,
        targetViewId,
        viewer,
        viewContexts: this.viewContexts,
      });
      const positions3D =
        await dimensionManager.getPositions3D(nextLevel);
      assertCurrentDimensionLoadOwner(this, loadOwner);
      if (
        !(positions3D instanceof Float32Array) ||
        positions3D.length !== this.pointCount * 3
      ) {
        throw new TypeError(
          `${nextLevel}D positions must contain exactly ` +
          `${this.pointCount * 3} Float32 values.`
        );
      }
      const previousPositions = isLiveView
        ? this.positionsArray
        : viewer.getViewPositions(targetViewId);
      if (
        !(previousPositions instanceof Float32Array) ||
        previousPositions.length !== this.pointCount * 3
      ) {
        throw new TypeError(
          `Published positions for view "${targetViewId}" are incomplete.`
        );
      }

      const previousGlobalCentroids = cloneCentroidState(this);
      const previousContextCentroids = cloneCentroidState(context);
      let stagedCentroids = null;
      if (hasCategoricalField) {
        this.activeDimensionLevel = nextLevel;
        try {
          this._ensureUserDefinedCentroidsForDim(field, nextLevel);
          this.buildCentroidsForField(field, { viewId: targetViewId });
          stagedCentroids = requireStagedCentroids(
            this,
            `View "${targetViewId}"`
          );
        } finally {
          this.activeDimensionLevel = previousActiveLevel;
          this.centroidPositions = previousGlobalCentroids.positions;
          this.centroidColors = previousGlobalCentroids.colors;
          this.centroidOutliers = previousGlobalCentroids.outliers;
          this.centroidLabels = previousGlobalCentroids.labels;
        }
      }
      assertCurrentDimensionLoadOwner(this, loadOwner);

      let positionPublicationAttempted = false;
      let centroidPublicationAttempted = false;
      let managerPublicationAttempted = false;
      let viewerDimensionPublicationAttempted = false;
      try {
        positionPublicationAttempted = true;
        if (isLiveView) {
          viewer.updatePositions(positions3D, nextLevel);
        } else {
          viewer.setViewPositions(
            targetViewId,
            positions3D,
            nextLevel
          );
        }

        if (stagedCentroids !== null) {
          centroidPublicationAttempted = true;
          if (isLiveView) {
            viewer.setCentroids({
              positions: stagedCentroids.positions,
              colors: stagedCentroids.colors,
            });
          } else {
            viewer.updateSnapshotAttributes(targetViewId, {
              centroidPositions: stagedCentroids.positions,
              centroidColors: stagedCentroids.colors,
            });
          }
          viewer.setCentroidLabels(
            stagedCentroids.labels,
            targetViewId
          );
        }

        managerPublicationAttempted = true;
        dimensionManager.setViewDimension(
          targetViewId,
          nextLevel
        );
        viewerDimensionPublicationAttempted = true;
        viewer.setViewDimension(targetViewId, nextLevel);

        if (isLiveView) {
          this.positionsArray = positions3D;
        }
        context.dimensionLevel = nextLevel;
        if (stagedCentroids !== null) {
          context.centroidPositions = stagedCentroids.positions;
          context.centroidColors = stagedCentroids.colors;
          context.centroidOutliers = stagedCentroids.outliers;
          context.centroidLabels = stagedCentroids.labels;
          if (isActiveView) {
            this.centroidPositions = stagedCentroids.positions;
            this.centroidColors = stagedCentroids.colors;
            this.centroidOutliers = stagedCentroids.outliers;
            this.centroidLabels = stagedCentroids.labels;
          }
        }
        if (isActiveView) {
          this.activeDimensionLevel = nextLevel;
        }
      } catch (error) {
        context.dimensionLevel = previousLevel;
        this.activeDimensionLevel = previousActiveLevel;
        if (isLiveView) {
          this.positionsArray = previousPositions;
        }
        context.centroidPositions = previousContextCentroids.positions;
        context.centroidColors = previousContextCentroids.colors;
        context.centroidOutliers = previousContextCentroids.outliers;
        context.centroidLabels = previousContextCentroids.labels;
        this.centroidPositions = previousGlobalCentroids.positions;
        this.centroidColors = previousGlobalCentroids.colors;
        this.centroidOutliers = previousGlobalCentroids.outliers;
        this.centroidLabels = previousGlobalCentroids.labels;

        const publicationErrors = [];
        const restore = operation => {
          try {
            operation();
          } catch (restoreError) {
            publicationErrors.push(restoreError);
          }
        };
        if (positionPublicationAttempted) {
          restore(() => {
            if (isLiveView) {
              viewer.updatePositions(
                previousPositions,
                previousLevel
              );
            } else {
              viewer.setViewPositions(
                targetViewId,
                previousPositions,
                previousLevel
              );
            }
          });
        }
        if (centroidPublicationAttempted) {
          restore(() => {
            if (isLiveView) {
              viewer.setCentroids({
                positions: previousContextCentroids.positions,
                colors: previousContextCentroids.colors,
              });
            } else {
              viewer.updateSnapshotAttributes(targetViewId, {
                centroidPositions:
                  previousContextCentroids.positions,
                centroidColors: previousContextCentroids.colors,
              });
            }
            viewer.setCentroidLabels(
              previousContextCentroids.labels,
              targetViewId
            );
          });
        }
        if (managerPublicationAttempted) {
          restore(() => {
            dimensionManager.setViewDimension(
              targetViewId,
              previousLevel
            );
          });
        }
        if (viewerDimensionPublicationAttempted) {
          restore(() => {
            viewer.setViewDimension(
              targetViewId,
              previousLevel
            );
          });
        }
        if (publicationErrors.length > 0) {
          throw new AggregateError(
            [error, ...publicationErrors],
            `Dimension publication for view "${targetViewId}" failed ` +
            'and state restoration was incomplete.'
          );
        }
        throw error;
      }
      // Listeners observe an already committed generation. A listener failure
      // must not drive the reversible renderer/manager publication backward
      // after another listener may already have observed the new level.
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
   * Notify listeners that the active view's dimension changed.
   * @private
   */
  _notifyDimensionChange() {
    const level = this.activeDimensionLevel;
    this.emit('dimension:changed', level);
  }

  /**
   * Get available dimensions from dimension manager
   * @returns {number[]} Array of available dimension levels
   */
  getAvailableDimensions() {
    requireMethod(
      this.dimensionManager,
      'getAvailableDimensions',
      'Dimension manager'
    );
    const dimensions = this.dimensionManager.getAvailableDimensions();
    if (!Array.isArray(dimensions)) {
      throw new TypeError(
        'Dimension manager available dimensions must be an array.'
      );
    }
    let previousDimension = 0;
    for (const dimension of dimensions) {
      requireDimensionLevel(dimension, 'Available dimension');
      if (dimension <= previousDimension) {
        throw new TypeError(
          'Available dimensions must be strictly increasing.'
        );
      }
      previousDimension = dimension;
    }
    return dimensions;
  }

  /**
   * Check if a specific dimension is available
   * @param {number} dim - Dimension level
   * @returns {boolean}
   */
  hasDimension(dim) {
    const dimension = requireDimensionLevel(dim);
    requireMethod(this.dimensionManager, 'hasDimension', 'Dimension manager');
    const result = this.dimensionManager.hasDimension(dimension);
    if (typeof result !== 'boolean') {
      throw new TypeError('Dimension manager hasDimension() must return a boolean.');
    }
    return result;
  }

}

Object.assign(DataStateViewMethods.prototype, viewContextCoreMethods, viewContextViewerSyncMethods);

export class ViewManager extends BaseManager {
  constructor(coordinator) {
    super(coordinator);
  }
}
