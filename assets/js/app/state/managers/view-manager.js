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
import { MappingLoadError } from '../../../data/data-mapping-candidates.js';

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

function requireRepresentationOptions(options) {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).length !== 1 ||
    typeof options.followsDefault !== 'boolean'
  ) {
    throw new TypeError(
      'Representation options must contain exactly one boolean "followsDefault".'
    );
  }
  return Object.freeze({ followsDefault: options.followsDefault });
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

function isDatasetViewLoadSupersededError(error) {
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
    && owner.dimensionManager.getViewLayout(owner.targetViewId)
      === owner.previousLayoutKey
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
      'Representation coordinate loading'
    );
  }
}

function isCurrentVectorLoadOwner(state, owner) {
  return (
    readDatasetGeneration(state) === owner.datasetGeneration
    && state.vectorFieldManager === owner.vectorFieldManager
    && state.viewer === owner.viewer
    && state.viewContexts === owner.viewContexts
    && owner.viewContexts.get('live') === owner.liveContext
    && state.pointCount === owner.pointCount
    && !viewerIsTerminal(owner.viewer)
  );
}

function assertCurrentVectorLoadOwner(state, owner) {
  if (!isCurrentVectorLoadOwner(state, owner)) {
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

  // --- Representations: the layout each view shows ---------------------------

  /**
   * Set the dimension manager instance
   * @param {DimensionManager} manager - The dimension manager
   */
  setDimensionManager(manager) {
    for (const methodName of [
      'getDefaultLayoutKey',
      'getEnabledLayoutKeys',
      'getLayout',
      'getPositions',
      'getViewLayout',
      'setViewLayout',
    ]) {
      requireMethod(manager, methodName, 'Dimension manager');
    }
    this.dimensionManager = manager;
    // Geometry the renderer keeps for representations no view shows is
    // released with their CPU positions, and all of it under memory pressure.
    if (typeof manager.setResidencyListener === 'function') {
      manager.setResidencyListener({
        onEvict: positions => this.viewer?.releaseRepresentationGeometry?.(positions),
        onPressure: () => this.viewer?.releaseRetainedGeometry?.(),
      });
    }
    const openingLayout = manager.getDefaultLayoutKey();
    if (openingLayout !== null) {
      manager.setViewLayout('live', openingLayout);
      const liveContext = this.viewContexts?.get?.('live');
      if (liveContext) liveContext.followsDefault = true;
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
        typeof manager.hasFieldLayout !== 'function' ||
        typeof manager.loadField !== 'function' ||
        typeof manager.dispose !== 'function'
      )
    ) {
      throw new TypeError(
        'setVectorFieldManager requires null or the exact vector-field manager interface.'
      );
    }
    const previous = this.vectorFieldManager;
    this.vectorFieldManager = manager;
    // The replaced manager's dataset is gone; stop its downloads.
    if (previous !== null && previous !== manager) {
      previous.dispose();
    }
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
   * @returns {{ id: string, label: string, layoutKeys: string[] }[]}
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

  /**
   * Ensure vector field data is loaded and uploaded to the viewer for one
   * representation (a layout some view shows). Each layout's data is loaded
   * once and drawn by every view that shows that layout.
   *
   * @param {string} fieldId
   * @param {string} layoutKey
   * @param {{ silent: boolean }} options
   * @returns {Promise<boolean>}
   */
  async ensureVectorField(fieldId, layoutKey, options) {
    if (typeof fieldId !== 'string' || fieldId.length === 0) {
      throw new TypeError('Vector field id must be a non-empty string.');
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
    const layout = this.dimensionManager.getLayout(layoutKey);
    const level = layout.dimension;
    if (!vectorFieldManager.hasFieldLayout(fieldId, layout.layoutKey)) {
      throw new Error(
        `Vector field "${fieldId}" has no data bound to ${layout.label}.`
      );
    }
    if (
      viewer === null ||
      typeof viewer !== 'object' ||
      typeof viewer.setVectorFieldData !== 'function' ||
      typeof viewer.hasVectorFieldForLayout !== 'function'
    ) {
      throw new TypeError(
        'The active viewer must provide vector-field upload and query methods.'
      );
    }
    if (viewer.hasVectorFieldForLayout(fieldId, layoutKey)) return true;
    if (
      !(this.viewContexts instanceof Map) ||
      !this.viewContexts.has('live')
    ) {
      throw new TypeError(
        'Vector-field loading requires the exact live view context.'
      );
    }

    const silent = options.silent;
    const notifications = silent ? null : getNotificationCenter();
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
    let readReported = false;
    try {
      const fieldData = await vectorFieldManager.loadField(fieldId, layoutKey);
      assertCurrentVectorLoadOwner(this, loadOwner);
      // The notification reports the read; drawing the field is the overlay's,
      // which reports its own failure (its caller shows it once).
      if (notifications !== null) {
        notifications.complete(notifId, `Loaded ${level}D ${descriptor.label}`);
        readReported = true;
      }
      viewer.setVectorFieldData(fieldId, layoutKey, fieldData);
      return true;
    } catch (error) {
      // A replaced manager aborts its downloads; a load whose owner is gone
      // is superseded, whatever the aborted download rejected with.
      const terminalError = isCurrentVectorLoadOwner(this, loadOwner)
        ? error
        : createDatasetViewLoadSupersededError('Vector-field loading');
      // A vector array whose values cannot be drawn stays unusable, with the
      // reason, in the data-mapping panel for the rest of this dataset.
      if (terminalError instanceof MappingLoadError) {
        this._markMappingChoiceUnusable('vectorFields', terminalError.key, terminalError.reason);
      }
      if (notifications !== null && !readReported) {
        if (isDatasetViewLoadSupersededError(terminalError)) {
          notifications.dismiss(notifId);
        } else {
          const message = terminalError instanceof Error
            ? terminalError.message
            : `Vector field "${fieldId}" rejected with a non-Error value.`;
          notifications.fail(notifId, message);
        }
      }
      throw terminalError;
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
   * The dimension of the representation the active view shows.
   * @returns {number} Dimension level (1, 2, or 3)
   */
  getDimensionLevel() {
    return this.getViewDimensionLevel(requireViewId(this.activeViewId));
  }

  /**
   * The dimension of the representation one view shows: always the
   * dimension of its layout, never a separately stored value.
   * @param {string} viewId - View identifier
   * @returns {number} Dimension level (1, 2, or 3)
   */
  getViewDimensionLevel(viewId) {
    const targetViewId = this._requireKnownView(viewId);
    requireMethod(this.dimensionManager, 'getViewLayout', 'Dimension manager');
    return requireDimensionLevel(
      this.dimensionManager.getLayout(
        this.dimensionManager.getViewLayout(targetViewId)
      ).dimension,
      `View "${targetViewId}" dimension`
    );
  }

  /**
   * The layout key of the representation a view shows, as the dimension
   * manager published it.
   * @param {string} viewId - View identifier
   * @returns {string}
   */
  getViewLayoutKey(viewId) {
    const targetViewId = requireViewId(viewId);
    requireMethod(
      this.dimensionManager,
      'getViewLayout',
      'Dimension manager'
    );
    return this.dimensionManager.getViewLayout(targetViewId);
  }

  /**
   * Whether a view shows its dimension's default because nothing else was
   * chosen for it (it follows the default when the mapping changes it), as
   * opposed to a representation the user picked.
   * @param {string} viewId
   * @returns {boolean}
   */
  viewFollowsDefault(viewId) {
    const targetViewId = this._requireKnownView(viewId);
    return this.viewContexts.get(targetViewId).followsDefault === true;
  }

  _requireKnownView(viewId) {
    const targetViewId = requireViewId(viewId);
    if (!(this.viewContexts instanceof Map)) {
      throw new TypeError('View lookup requires the exact view-context map.');
    }
    const context = this.viewContexts.get(targetViewId);
    if (
      context === null ||
      typeof context !== 'object' ||
      Array.isArray(context) ||
      context.id !== targetViewId
    ) {
      throw new RangeError(`View "${targetViewId}" does not exist.`);
    }
    return targetViewId;
  }

  /**
   * Show one dimension's default representation in a view (its first
   * enabled representation when the mapping names no default for it). The
   * view then follows that dimension's default.
   *
   * @param {string} viewId
   * @param {number} level
   * @returns {Promise<string>} The layout key now shown.
   */
  async showDefaultRepresentation(viewId, level) {
    const dimension = requireDimensionLevel(level);
    requireMethod(this.dimensionManager, 'getOpeningLayout', 'Dimension manager');
    const layoutKey = this.dimensionManager.getOpeningLayout(dimension);
    if (layoutKey === null) {
      throw new RangeError(`No ${dimension}D representation is enabled for this dataset.`);
    }
    await this.setViewRepresentation(viewId, layoutKey, {
      followsDefault: this.dimensionManager.getDefaultLayout(dimension) === layoutKey,
    });
    return layoutKey;
  }

  /**
   * The keyboard gesture for one dimension: a view showing another dimension
   * switches to this dimension's default; a view already showing this
   * dimension moves to its next enabled representation, wrapping around.
   *
   * @param {string} viewId
   * @param {number} level
   * @returns {Promise<{layoutKey: string, position: number, count: number}>}
   *   What the view shows now, and its 1-based place among the enabled
   *   representations of that dimension.
   */
  async cycleRepresentation(viewId, level) {
    const dimension = requireDimensionLevel(level);
    const targetViewId = this._requireKnownView(viewId);
    // The dimension's default first, then its other representations in the
    // mapping's order: the order the picker lists them in.
    const defaultLayout = this.dimensionManager.getDefaultLayout(dimension);
    const choices = this.dimensionManager
      .getEnabledLayoutsForDimension(dimension)
      .map(layout => layout.layoutKey)
      .sort((left, right) => (right === defaultLayout) - (left === defaultLayout));
    if (choices.length === 0) {
      throw new RangeError(`No ${dimension}D representation is enabled for this dataset.`);
    }
    const current = this.getViewLayoutKey(targetViewId);
    let layoutKey;
    if (this.getViewDimensionLevel(targetViewId) !== dimension) {
      layoutKey = await this.showDefaultRepresentation(targetViewId, dimension);
    } else {
      const index = choices.indexOf(current);
      layoutKey = choices[(index + 1) % choices.length];
      await this.setViewRepresentation(targetViewId, layoutKey, {
        followsDefault: this.dimensionManager.getDefaultLayout(dimension) === layoutKey,
      });
    }
    return { layoutKey, position: choices.indexOf(layoutKey) + 1, count: choices.length };
  }

  /**
   * Show the representation one embedding reference names in a view: an
   * explicit choice, which the view keeps when the mapping's defaults
   * change. The reference must name an enabled representation.
   *
   * @param {string} viewId
   * @param {{key: string, columns: number[]|null}} ref
   * @returns {Promise<string>} The layout key now shown.
   */
  async setViewEmbedding(viewId, ref) {
    requireMethod(this.dimensionManager, 'resolveRepresentation', 'Dimension manager');
    const layoutKey = this.dimensionManager.resolveRepresentation(ref);
    await this.setViewRepresentation(viewId, layoutKey, { followsDefault: false });
    return layoutKey;
  }

  /**
   * Show the representation a saved session names in a view. A session
   * records what each view showed, not whether it was chosen, so a view that
   * shows its dimension's default follows that default again.
   *
   * @param {string} viewId
   * @param {{key: string, columns: number[]|null}} ref
   * @returns {Promise<string>} The layout key now shown.
   */
  async restoreViewEmbedding(viewId, ref) {
    requireMethod(this.dimensionManager, 'resolveRepresentation', 'Dimension manager');
    const layoutKey = this.dimensionManager.resolveRepresentation(ref);
    const dimension = this.dimensionManager.getLayout(layoutKey).dimension;
    await this.setViewRepresentation(viewId, layoutKey, {
      followsDefault: this.dimensionManager.getDefaultLayout(dimension) === layoutKey,
    });
    return layoutKey;
  }

  /**
   * Set the representation one view shows, as one transaction: coordinates
   * and centroids are staged first, then the renderer, the dimension manager
   * and the viewer publish the new layout, and any failure restores all of
   * them. A request for the layout the view already shows only records
   * whether it follows the default.
   *
   * Every view, active or not, announces a change with
   * `view:representation-changed` `{viewId, layoutKey, dimension,
   * previousLayoutKey}` once it is committed.
   *
   * @param {string} viewId - Exact target view
   * @param {string} layoutKey - An enabled layout
   * @param {{followsDefault: boolean}} options
   * @returns {Promise<void>}
   */
  async setViewRepresentation(viewId, layoutKey, options) {
    const targetViewId = requireViewId(viewId);
    const { followsDefault } = requireRepresentationOptions(options);

    // Serialize layout transactions so their staged coordinates and
    // centroid buffers cannot overlap across an await boundary.
    while (this._dimensionChangeLock) {
      await this._dimensionChangeLock;
    }

    let unlockDimensionChange = null;
    this._dimensionChangeLock = new Promise((resolve) => {
      unlockDimensionChange = resolve;
    });
    let releaseLayoutPin = null;

    try {
      const dimensionManager = this.dimensionManager;
      const viewer = this.viewer;
      for (const methodName of [
        'getLayout',
        'getPositions',
        'getViewLayout',
        'isEnabled',
        'pinLayout',
        'setViewLayout',
      ]) {
        requireMethod(
          dimensionManager,
          methodName,
          'Dimension manager'
        );
      }
      requireMethod(this, 'getFieldForView', 'DataState');
      requireMethod(viewer, 'setViewEmbedding', 'Viewer');
      this._requireKnownView(targetViewId);
      const context = this.viewContexts.get(targetViewId);
      const nextLayout = dimensionManager.getLayout(layoutKey);
      const nextLayoutKey = nextLayout.layoutKey;
      if (!dimensionManager.isEnabled(nextLayoutKey)) {
        throw new RangeError(
          `${nextLayout.label} is not enabled for this dataset. Enable it in Data mapping first.`
        );
      }
      const nextLevel = requireDimensionLevel(nextLayout.dimension);
      const previousLayoutKey =
        dimensionManager.getViewLayout(targetViewId);
      const previousLevel = requireDimensionLevel(
        dimensionManager.getLayout(previousLayoutKey).dimension
      );
      const previousFollowsDefault = context.followsDefault === true;
      const activeViewId = requireViewId(this.activeViewId);
      const isActiveView = targetViewId === activeViewId;
      if (nextLayoutKey === previousLayoutKey) {
        context.followsDefault = followsDefault;
        return;
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
          '_ensureUserDefinedCentroidsForLayout',
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
      // layout owner publishes the new layout. The pin keeps the staged
      // coordinates resident while other loads run before publication.
      const loadOwner = Object.freeze({
        activeViewId,
        context,
        datasetGeneration: readDatasetGeneration(this),
        dimensionManager,
        field,
        pointCount: this.pointCount,
        previousLayoutKey,
        targetViewId,
        viewer,
        viewContexts: this.viewContexts,
      });
      releaseLayoutPin = dimensionManager.pinLayout(nextLayoutKey);
      const nextPositions =
        await dimensionManager.getPositions(nextLayoutKey);
      assertCurrentDimensionLoadOwner(this, loadOwner);
      if (
        !(nextPositions instanceof Float32Array) ||
        nextPositions.length !== this.pointCount * nextLevel
      ) {
        throw new TypeError(
          `${nextLevel}D positions must contain exactly ` +
          `${this.pointCount * nextLevel} Float32 values.`
        );
      }
      if (isLiveView && this.positionsDimension !== previousLevel) {
        throw new Error(
          'Live positions are not published in the live view dimension.'
        );
      }
      const previousPositions = isLiveView
        ? this.positionsArray
        : viewer.getViewPositions(targetViewId);
      if (
        !(previousPositions instanceof Float32Array) ||
        previousPositions.length !== this.pointCount * previousLevel
      ) {
        throw new TypeError(
          `Published positions for view "${targetViewId}" are incomplete.`
        );
      }

      const previousGlobalCentroids = cloneCentroidState(this);
      const previousContextCentroids = cloneCentroidState(context);
      let stagedCentroids = null;
      if (hasCategoricalField) {
        try {
          this._ensureUserDefinedCentroidsForLayout(
            field,
            nextLayoutKey,
            nextPositions
          );
          this.buildCentroidsForField(field, {
            viewId: targetViewId,
            layoutKey: nextLayoutKey,
          });
          stagedCentroids = requireStagedCentroids(
            this,
            `View "${targetViewId}"`
          );
        } finally {
          this.centroidPositions = previousGlobalCentroids.positions;
          this.centroidColors = previousGlobalCentroids.colors;
          this.centroidLabels = previousGlobalCentroids.labels;
        }
      }
      assertCurrentDimensionLoadOwner(this, loadOwner);

      let positionPublicationAttempted = false;
      let centroidPublicationAttempted = false;
      let managerPublicationAttempted = false;
      let viewerLayoutPublicationAttempted = false;
      try {
        positionPublicationAttempted = true;
        if (isLiveView) {
          viewer.updatePositions(nextPositions, nextLevel);
        } else {
          viewer.setViewPositions(
            targetViewId,
            nextPositions,
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
        dimensionManager.setViewLayout(targetViewId, nextLayoutKey);
        viewerLayoutPublicationAttempted = true;
        viewer.setViewEmbedding(targetViewId, {
          dimension: nextLevel,
          layoutKey: nextLayoutKey,
        });

        if (isLiveView) {
          this.positionsArray = nextPositions;
          this.positionsDimension = nextLevel;
        }
        context.followsDefault = followsDefault;
        if (stagedCentroids !== null) {
          context.centroidPositions = stagedCentroids.positions;
          context.centroidColors = stagedCentroids.colors;
          context.centroidLabels = stagedCentroids.labels;
          if (isActiveView) {
            this.centroidPositions = stagedCentroids.positions;
            this.centroidColors = stagedCentroids.colors;
            this.centroidLabels = stagedCentroids.labels;
          }
        }
      } catch (error) {
        context.followsDefault = previousFollowsDefault;
        if (isLiveView) {
          this.positionsArray = previousPositions;
          this.positionsDimension = previousLevel;
        }
        context.centroidPositions = previousContextCentroids.positions;
        context.centroidColors = previousContextCentroids.colors;
        context.centroidLabels = previousContextCentroids.labels;
        this.centroidPositions = previousGlobalCentroids.positions;
        this.centroidColors = previousGlobalCentroids.colors;
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
            dimensionManager.setViewLayout(
              targetViewId,
              previousLayoutKey
            );
          });
        }
        if (viewerLayoutPublicationAttempted) {
          restore(() => {
            viewer.setViewEmbedding(targetViewId, {
              dimension: previousLevel,
              layoutKey: previousLayoutKey,
            });
          });
        }
        if (publicationErrors.length > 0) {
          throw new AggregateError(
            [error, ...publicationErrors],
            `Representation publication for view "${targetViewId}" failed ` +
            'and state restoration was incomplete.'
          );
        }
        throw error;
      }
      // Listeners observe an already committed generation. A listener failure
      // must not drive the reversible renderer/manager publication backward
      // after another listener may already have observed the new layout.
      this._notifyRepresentationChange(targetViewId, previousLayoutKey);
    } finally {
      if (typeof releaseLayoutPin === 'function') {
        releaseLayoutPin();
      }
      if (typeof unlockDimensionChange === 'function') {
        unlockDimensionChange();
      }
      this._dimensionChangeLock = null;
    }
  }

  /**
   * Announce that the representation one view shows changed: a committed
   * `setViewRepresentation`, or the active view moving to a view that shows
   * another representation (`previousLayoutKey` is then the representation
   * the previously active view showed).
   *
   * @param {string} viewId
   * @param {string|null} previousLayoutKey
   * @private
   */
  _notifyRepresentationChange(viewId, previousLayoutKey) {
    const layoutKey = this.dimensionManager.getViewLayout(viewId);
    this.emit('view:representation-changed', Object.freeze({
      viewId,
      layoutKey,
      dimension: this.dimensionManager.getLayout(layoutKey).dimension,
      previousLayoutKey,
    }));
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
