/**
 * @fileoverview Exact multiview snapshot graph restoration.
 *
 * A session records, per view, only what the person chose: its embedding,
 * camera, active field, filters and centroid toggles. Labels and filter
 * summaries are derived from those and recomputed when the view is rebuilt.
 *
 * Restore replays each kept view once on the live view and publishes it, then
 * applies the live view's own state last. Each view therefore costs one filter
 * application, one colour pass and one embedding switch; nothing is reset to
 * a base state in between, because every replay applies a complete state (the
 * filter restore clears every field first, and the active field and embedding
 * are set explicitly).
 *
 * @module state-serializer/multiview
 */

import {
  assertCameraState,
  cameraStatesHaveSamePose,
  cloneCameraState
} from '../../rendering/camera-state-contract.js';
import {
  clearPublishedSnapshotViews,
  publishSnapshotView
} from '../view-snapshot-publication.js';
import {
  assertActiveFieldsState,
  validateActiveFieldsForState
} from './active-fields.js';
import { readFieldInventory, validateFiltersForState } from './filters.js';
import {
  assertArray,
  assertBoolean,
  assertExactKeys,
  assertNonEmptyString,
  assertPlainRecord,
  requireMethod
} from '../session/schema-contract.js';
import { requireRepresentationRef } from '../../data/dimension-manager.js';
import { yieldToMacrotask } from '../../utils/yield-macrotask.js';

const MULTIVIEW_KEYS = [
  'layout',
  'camerasLocked',
  'live',
  'snapshots'
];
const LAYOUT_KEYS = ['mode', 'activeId', 'liveViewHidden'];
const LIVE_KEYS = ['cameraState', 'centroids'];
const SNAPSHOT_KEYS = [
  'id',
  'embedding',
  'cameraState',
  'activeFields',
  'filters',
  'centroids'
];
const CENTROID_KEYS = ['points', 'labels'];

function assertSnapshotId(value, context) {
  const id = assertNonEmptyString(value, context);
  if (!/^snap_[1-9]\d*$/.test(id)) {
    throw new TypeError(`${context} must use the current "snap_<positive integer>" identity.`);
  }
  return id;
}

export function assertCentroidFlags(value, context) {
  assertExactKeys(value, CENTROID_KEYS, context);
  assertBoolean(value.points, `${context} points`);
  assertBoolean(value.labels, `${context} labels`);
  return value;
}

/**
 * @param {object} state
 * @param {unknown} multiview
 * @param {ReturnType<typeof readFieldInventory>} [inventory]
 */
export function assertMultiviewState(state, multiview, inventory = null) {
  assertExactKeys(multiview, MULTIVIEW_KEYS, 'Multiview session state');
  assertBoolean(multiview.camerasLocked, 'Multiview camerasLocked');
  assertExactKeys(multiview.live, LIVE_KEYS, 'Multiview live view');
  assertCameraState(multiview.live.cameraState, 'Multiview live camera state');
  assertCentroidFlags(multiview.live.centroids, 'Multiview live centroids');
  assertExactKeys(multiview.layout, LAYOUT_KEYS, 'Multiview layout');
  if (multiview.layout.mode !== 'single' && multiview.layout.mode !== 'grid') {
    throw new TypeError('Multiview layout mode must be "single" or "grid".');
  }
  const activeId = assertNonEmptyString(
    multiview.layout.activeId,
    'Multiview layout activeId'
  );
  assertBoolean(multiview.layout.liveViewHidden, 'Multiview layout liveViewHidden');
  assertArray(multiview.snapshots, 'Multiview snapshots');

  const fieldInventory = inventory ?? readFieldInventory(state);
  const snapshotIds = new Set();
  for (let index = 0; index < multiview.snapshots.length; index++) {
    const snapshot = multiview.snapshots[index];
    const context = `Multiview snapshot ${index}`;
    assertExactKeys(snapshot, SNAPSHOT_KEYS, context);
    const snapshotId = assertSnapshotId(snapshot.id, `${context} id`);
    if (snapshotIds.has(snapshotId)) {
      throw new TypeError(`Multiview snapshot id "${snapshotId}" is duplicated.`);
    }
    snapshotIds.add(snapshotId);
    requireRepresentationRef(snapshot.embedding);
    assertCameraState(snapshot.cameraState, `${context} camera state`);
    assertActiveFieldsState(snapshot.activeFields);
    assertPlainRecord(snapshot.filters, `${context} filters`);
    assertCentroidFlags(snapshot.centroids, `${context} centroids`);
    validateActiveFieldsForState(state, snapshot.activeFields, fieldInventory);
    validateFiltersForState(state, snapshot.filters, fieldInventory);
  }

  if (activeId !== 'live' && !snapshotIds.has(activeId)) {
    throw new RangeError(`Multiview activeId "${activeId}" is not in its snapshot inventory.`);
  }
  if (multiview.layout.liveViewHidden) {
    if (multiview.snapshots.length === 0 || activeId === 'live') {
      throw new TypeError('A hidden live view requires an active snapshot.');
    }
  }
  return multiview;
}

/**
 * The camera of the view a multiview record focuses.
 * @param {object} multiview - A validated multiview record.
 * @returns {object}
 */
export function focusedCameraState(multiview) {
  const activeId = multiview.layout.activeId;
  if (activeId === 'live') return multiview.live.cameraState;
  return multiview.snapshots.find(snapshot => snapshot.id === activeId).cameraState;
}

function requireRestoreOwners({
  state,
  viewer,
  restoreFilters,
  restoreActiveFields
}) {
  if (state === null || typeof state !== 'object') {
    throw new TypeError('Multiview restore requires the current DataState owner.');
  }
  if (viewer === null || typeof viewer !== 'object') {
    throw new TypeError('Multiview restore requires the current viewer owner.');
  }
  for (const method of [
    'applySnapshotConfigToView',
    'beginBatch',
    'createViewFromSource',
    'getActiveViewId',
    'getDimensionManager',
    'getSnapshotPayload',
    'getViewDimensionLevel',
    'getViewEmbeddingRef',
    'getViewLayoutKey',
    'endBatch',
    'removeView',
    'restoreViewEmbedding',
    'setActiveView',
    'syncSnapshotContexts'
  ]) {
    requireMethod(state, method, 'Multiview DataState owner');
  }
  for (const method of [
    'clearSnapshotViews',
    'createSnapshotView',
    'getCamerasLocked',
    'getSnapshotViews',
    'getViewCameraState',
    'getViewLayoutKey',
    'removeSnapshotView',
    'setCameraState',
    'setCamerasLocked',
    'setLiveViewHidden',
    'setShowCentroidLabels',
    'setShowCentroidPoints',
    'setViewLayout',
    'setViewCameraState'
  ]) {
    requireMethod(viewer, method, 'Multiview viewer owner');
  }
  for (const [fn, context] of [
    [restoreFilters, 'Multiview restoreFilters'],
    [restoreActiveFields, 'Multiview restoreActiveFields']
  ]) {
    if (typeof fn !== 'function') {
      throw new TypeError(`${context} must be a function.`);
    }
  }
}

function applyCentroidFlags(viewer, viewId, flags) {
  viewer.setShowCentroidPoints(flags.points, viewId);
  viewer.setShowCentroidLabels(flags.labels, viewId);
}

/**
 * Rebuild the saved view graph: every kept view, then the live view.
 *
 * @param {{state: object, viewer: object, restoreFilters: (filters: object) => Promise<unknown>, restoreActiveFields: (activeFields: object) => Promise<unknown>}} owners
 * @param {object} multiview - The saved multiview record.
 * @param {{embedding: object, filters: object, activeFields: object}} live -
 *   The live view's own state, applied after the kept views.
 */
export async function restoreMultiview(owners, multiview, live) {
  assertMultiviewState(owners.state, multiview);
  requireRestoreOwners(owners);
  assertExactKeys(live, ['embedding', 'filters', 'activeFields'], 'Multiview live state');
  const {
    state,
    viewer,
    restoreFilters,
    restoreActiveFields
  } = owners;

  // The graph rollback returns the live view to where this restore found it.
  // That pose is reachable by construction — the viewer reported it — whereas
  // the saved pose is exactly the one a failed replay may have just proven
  // unreachable, and re-asserting it from the rollback would only fail again.
  const priorCamerasLocked = viewer.getCamerasLocked();
  const priorLiveCameraState = cloneCameraState(
    viewer.getViewCameraState('live'),
    'Live camera state before multiview restore'
  );

  function applyLiveCamera(cameraState, description) {
    viewer.setViewCameraState('live', cameraState);
    if (
      !cameraStatesHaveSamePose(
        viewer.getViewCameraState('live'),
        cameraState
      )
    ) {
      throw new Error(
        `Multiview restoration did not preserve the exact ${description}.`
      );
    }
  }

  async function applyViewState(viewState, description) {
    // Filters and active field in one batch: the view's visibility is
    // computed once, from both (each alone would compute it again).
    state.beginBatch();
    try {
      await restoreFilters(viewState.filters);
      await restoreActiveFields(viewState.activeFields);
    } finally {
      state.endBatch();
    }
    // The embedding switch in a task of its own: with its centroids and
    // geometry it would otherwise share one long task with the field's.
    await yieldToMacrotask();
    await state.restoreViewEmbedding('live', viewState.embedding);
    if (
      JSON.stringify(state.getViewEmbeddingRef('live'))
        !== JSON.stringify(viewState.embedding)
    ) {
      throw new Error(`${description} did not restore its exact embedding.`);
    }
  }

  try {
    if (state.getActiveViewId() !== 'live') {
      if (state.setActiveView('live') !== 'live') {
        throw new Error('Multiview restoration could not activate the live view.');
      }
    }
    clearPublishedSnapshotViews({ state, viewer });
    viewer.setCamerasLocked(multiview.camerasLocked);

    const idMap = new Map();
    for (const snapshot of multiview.snapshots) {
      // One view per task: with every field already loaded a replay is
      // synchronous work, and the views of a large session would otherwise
      // be rebuilt in one long task. A macrotask, not a frame, so a restore
      // in a background tab or an off-screen notebook still runs.
      await yieldToMacrotask();
      await applyViewState(snapshot, `Replayed snapshot "${snapshot.id}"`);
      const snapshotDimension = state.getViewDimensionLevel('live');
      const payload = state.getSnapshotPayload();
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new TypeError('Multiview getSnapshotPayload() must return an object.');
      }
      if (payload.dimensionLevel !== snapshotDimension) {
        throw new Error(
          `Replayed snapshot "${snapshot.id}" does not match its embedding dimension.`
        );
      }
      assertArray(payload.filtersText, `Replayed snapshot "${snapshot.id}" filtersText`);
      const created = publishSnapshotView({
        state,
        viewer,
        config: {
          label: payload.label,
          fieldKey: payload.fieldKey,
          fieldKind: payload.fieldKind,
          colors: payload.colors,
          transparency: payload.transparency,
          centroidPositions: payload.centroidPositions,
          centroidColors: payload.centroidColors,
          sourceViewId: 'live',
          meta: {
            filtersText: [...payload.filtersText]
          },
          dimensionLevel: snapshotDimension,
          cameraState: snapshot.cameraState
        }
      });
      const newId = assertSnapshotId(created.id, 'Created multiview snapshot id');
      if ([...idMap.values()].includes(newId)) {
        throw new TypeError(`Viewer created duplicate snapshot id "${newId}".`);
      }
      idMap.set(snapshot.id, newId);
      applyCentroidFlags(viewer, newId, snapshot.centroids);
    }

    await yieldToMacrotask();
    await applyViewState(live, 'The live view');
    applyCentroidFlags(viewer, 'live', multiview.live.centroids);
    applyLiveCamera(multiview.live.cameraState, 'saved live camera');

    const savedActiveId = multiview.layout.activeId;
    const resolvedActiveId = savedActiveId === 'live'
      ? 'live'
      : idMap.get(savedActiveId);
    if (resolvedActiveId === undefined) {
      throw new Error(
        `Multiview active snapshot "${savedActiveId}" was not created.`
      );
    }

    viewer.setViewLayout(multiview.layout.mode, resolvedActiveId);
    viewer.setLiveViewHidden(multiview.layout.liveViewHidden);
    const activeResult = state.setActiveView(resolvedActiveId);
    if (activeResult !== resolvedActiveId) {
      throw new Error(
        `DataState rejected restored active view "${resolvedActiveId}".`
      );
    }

    const activeCamera = assertCameraState(
      viewer.getViewCameraState(resolvedActiveId),
      `Restored active camera for "${resolvedActiveId}"`
    );
    viewer.setCameraState(activeCamera);
  } catch (error) {
    const cleanupFailures = [];
    try {
      clearPublishedSnapshotViews({ state, viewer });
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    try {
      if (state.getActiveViewId() !== 'live') state.setActiveView('live');
      if (viewer.getCamerasLocked() !== priorCamerasLocked) {
        viewer.setCamerasLocked(priorCamerasLocked);
      }
      applyLiveCamera(priorLiveCameraState, 'live camera it started from');
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        'Multiview restoration failed and graph rollback was incomplete.'
      );
    }
    throw error;
  }
}
