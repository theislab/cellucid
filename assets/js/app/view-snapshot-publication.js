/**
 * @fileoverview Atomic application ownership for viewer snapshot generations.
 *
 * A snapshot is usable by the app only when the renderer inventory, DataState
 * context, and DimensionManager mapping all describe the same generation.
 * These helpers publish, retire, and reconcile those owners as one operation.
 */

function requireMethod(owner, methodName, label) {
  if (
    owner === null ||
    typeof owner !== 'object' ||
    typeof owner[methodName] !== 'function'
  ) {
    throw new TypeError(`${label} must provide ${methodName}().`);
  }
}

function requireViewId(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireSnapshotInventory(viewer) {
  const snapshots = viewer.getSnapshotViews();
  if (!Array.isArray(snapshots)) {
    throw new TypeError('Viewer snapshot inventory must be an array.');
  }
  const ids = new Set();
  for (const snapshot of snapshots) {
    const id = requireViewId(snapshot?.id, 'Viewer snapshot id');
    if (ids.has(id)) {
      throw new TypeError(`Viewer published duplicate snapshot id "${id}".`);
    }
    ids.add(id);
  }
  return snapshots;
}

function snapshotIds(viewer) {
  return requireSnapshotInventory(viewer).map(snapshot => snapshot.id);
}

function requireSnapshotOwners(state, viewer) {
  for (const methodName of [
    'applySnapshotConfigToView',
    'createViewFromSource',
    'getDimensionManager',
    'getViewDimensionLevel',
    'removeView',
    'syncSnapshotContexts',
  ]) {
    requireMethod(state, methodName, 'Snapshot state owner');
  }
  for (const methodName of [
    'clearSnapshotViews',
    'createSnapshotView',
    'getSnapshotViews',
    'removeSnapshotView',
  ]) {
    requireMethod(viewer, methodName, 'Snapshot viewer owner');
  }
}

function throwWithCleanupFailures(error, cleanupFailures, message) {
  if (cleanupFailures.length === 0) throw error;
  throw new AggregateError(
    [error, ...cleanupFailures],
    message
  );
}

function removeStateViewWithRetry(state, viewId, cleanupFailures) {
  try {
    state.removeView(viewId);
  } catch (error) {
    cleanupFailures.push(error);
    try {
      state.removeView(viewId);
    } catch (retryError) {
      cleanupFailures.push(retryError);
    }
  }
}

export function publishSnapshotView({ state, viewer, config }) {
  requireSnapshotOwners(state, viewer);
  if (
    config === null ||
    typeof config !== 'object' ||
    Array.isArray(config)
  ) {
    throw new TypeError(
      'Snapshot application publication requires one configuration object.'
    );
  }
  const sourceViewId = requireViewId(
    config.sourceViewId,
    'Snapshot source view id'
  );
  const sourceDimension = state.getViewDimensionLevel(sourceViewId);
  if (config.dimensionLevel !== sourceDimension) {
    throw new Error(
      `Snapshot dimension ${String(config.dimensionLevel)} does not match ` +
      `source view "${sourceViewId}" dimension ${sourceDimension}.`
    );
  }
  const beforeIds = new Set(snapshotIds(viewer));
  let createdId = null;
  let stateContextCreated = false;
  try {
    const created = viewer.createSnapshotView(config);
    if (
      created === null ||
      typeof created !== 'object' ||
      Array.isArray(created)
    ) {
      throw new TypeError(
        'Viewer snapshot creation must return one identity record.'
      );
    }
    createdId = requireViewId(created.id, 'Created snapshot id');
    if (beforeIds.has(createdId)) {
      throw new Error(
        `Viewer reused existing snapshot identity "${createdId}".`
      );
    }
    if (created.label !== config.label) {
      throw new Error(
        'Viewer changed the exact snapshot label during publication.'
      );
    }
    const after = requireSnapshotInventory(viewer);
    if (
      after.length !== beforeIds.size + 1 ||
      !after.some(snapshot => snapshot.id === createdId)
    ) {
      throw new Error(
        `Viewer did not publish exactly one snapshot "${createdId}".`
      );
    }

    state.createViewFromSource(sourceViewId, createdId);
    stateContextCreated = true;
    state.applySnapshotConfigToView(createdId, config);
    const dimensionManager = state.getDimensionManager();
    requireMethod(
      dimensionManager,
      'copyViewDimension',
      'Snapshot dimension owner'
    );
    requireMethod(
      dimensionManager,
      'getViewDimension',
      'Snapshot dimension owner'
    );
    dimensionManager.copyViewDimension(sourceViewId, createdId);
    if (
      dimensionManager.getViewDimension(createdId) !==
      config.dimensionLevel
    ) {
      throw new Error(
        `Dimension owner published the wrong dimension for snapshot "${createdId}".`
      );
    }
    state.syncSnapshotContexts(after.map(snapshot => snapshot.id));
    return created;
  } catch (error) {
    const cleanupFailures = [];
    const cleanup = operation => {
      try {
        operation();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    };
    let rollbackIds = createdId === null ? [] : [createdId];
    cleanup(() => {
      rollbackIds = requireSnapshotInventory(viewer)
        .map(snapshot => snapshot.id)
        .filter(id => !beforeIds.has(id));
    });
    for (const rollbackId of rollbackIds) {
      cleanup(() => viewer.removeSnapshotView(rollbackId));
    }
    let survivingIds = [];
    let survivingInventoryRead = false;
    cleanup(() => {
      survivingIds = snapshotIds(viewer);
      survivingInventoryRead = true;
    });
    const survivingIdSet = new Set(survivingIds);
    if (survivingInventoryRead) {
      for (const rollbackId of rollbackIds) {
        if (!survivingIdSet.has(rollbackId)) {
          cleanup(() => {
            removeStateViewWithRetry(
              state,
              rollbackId,
              cleanupFailures
            );
          });
        }
      }
    }
    if (
      stateContextCreated &&
      createdId !== null &&
      survivingIdSet.has(createdId)
    ) {
      cleanupFailures.push(
        new Error(
          `Snapshot "${createdId}" remains published after rollback.`
        )
      );
    }
    if (survivingInventoryRead) {
      cleanup(() => state.syncSnapshotContexts(survivingIds));
    }
    throwWithCleanupFailures(
      error,
      cleanupFailures,
      'Snapshot publication failed and ownership rollback was incomplete.'
    );
  }
}

export function retireSnapshotView({ state, viewer, snapshotId }) {
  requireSnapshotOwners(state, viewer);
  const exactId = requireViewId(snapshotId, 'Retired snapshot id');
  const before = requireSnapshotInventory(viewer);
  if (!before.some(snapshot => snapshot.id === exactId)) {
    throw new RangeError(`Snapshot "${exactId}" does not exist.`);
  }

  let retirementError = null;
  try {
    viewer.removeSnapshotView(exactId);
  } catch (error) {
    retirementError = error;
  }
  const cleanupFailures = [];
  let after;
  try {
    after = requireSnapshotInventory(viewer);
  } catch (inventoryError) {
    if (retirementError !== null) {
      throw new AggregateError(
        [retirementError, inventoryError],
        `Snapshot "${exactId}" retirement left its viewer inventory unknown.`
      );
    }
    throw inventoryError;
  }
  if (!after.some(snapshot => snapshot.id === exactId)) {
    removeStateViewWithRetry(state, exactId, cleanupFailures);
  }
  try {
    state.syncSnapshotContexts(after.map(snapshot => snapshot.id));
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (retirementError !== null) {
    throwWithCleanupFailures(
      retirementError,
      cleanupFailures,
      `Snapshot "${exactId}" retired with incomplete state reconciliation.`
    );
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      cleanupFailures,
      `Snapshot "${exactId}" retired with incomplete state reconciliation.`
    );
  }
  if (after.some(snapshot => snapshot.id === exactId)) {
    throw new Error(`Viewer did not remove snapshot "${exactId}".`);
  }
  return after;
}

export function clearPublishedSnapshotViews({ state, viewer }) {
  requireSnapshotOwners(state, viewer);
  const before = requireSnapshotInventory(viewer);
  let retirementError = null;
  try {
    viewer.clearSnapshotViews();
  } catch (error) {
    retirementError = error;
  }

  const cleanupFailures = [];
  let after = [];
  let afterInventoryRead = false;
  try {
    after = requireSnapshotInventory(viewer);
    afterInventoryRead = true;
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (afterInventoryRead) {
    const survivingIds = new Set(after.map(snapshot => snapshot.id));
    for (const snapshot of before) {
      if (survivingIds.has(snapshot.id)) continue;
      removeStateViewWithRetry(
        state,
        snapshot.id,
        cleanupFailures
      );
    }
    try {
      state.syncSnapshotContexts(after.map(snapshot => snapshot.id));
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  if (retirementError !== null) {
    throwWithCleanupFailures(
      retirementError,
      cleanupFailures,
      'Snapshot clearing failed with incomplete state reconciliation.'
    );
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      cleanupFailures,
      'Snapshot clearing completed with incomplete state reconciliation.'
    );
  }
  if (after.length !== 0) {
    throw new Error(
      `Viewer retained ${after.length} snapshot(s) after clearSnapshotViews().`
    );
  }
  return after;
}
