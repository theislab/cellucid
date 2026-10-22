/**
 * @fileoverview Exact multiview snapshot graph restoration.
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
import { validateFiltersForState } from './filters.js';
import {
  assertArray,
  assertBoolean,
  assertExactKeys,
  assertNonEmptyString,
  assertNullableString,
  assertPlainRecord,
  requireMethod
} from '../session/schema-contract.js';
import { requireRepresentationRef } from '../../data/dimension-manager.js';

const MULTIVIEW_KEYS = [
  'layout',
  'camerasLocked',
  'liveCameraState',
  'snapshots'
];
const LAYOUT_KEYS = ['mode', 'activeId', 'liveViewHidden'];
const SNAPSHOT_KEYS = [
  'id',
  'label',
  'fieldKey',
  'fieldKind',
  'meta',
  'embedding',
  'cameraState',
  'activeFields',
  'filters'
];

function assertSnapshotId(value, context) {
  const id = assertNonEmptyString(value, context);
  if (!/^snap_[1-9]\d*$/.test(id)) {
    throw new TypeError(`${context} must use the current "snap_<positive integer>" identity.`);
  }
  return id;
}

function assertSnapshotMeta(meta, context) {
  assertExactKeys(meta, ['filtersText'], context);
  assertArray(meta.filtersText, `${context} filtersText`);
  for (const line of meta.filtersText) {
    if (typeof line !== 'string') {
      throw new TypeError(`${context} filtersText entries must be strings.`);
    }
  }
}

export function assertMultiviewState(state, multiview) {
  assertExactKeys(multiview, MULTIVIEW_KEYS, 'Multiview session state');
  assertBoolean(multiview.camerasLocked, 'Multiview camerasLocked');
  assertCameraState(multiview.liveCameraState, 'Multiview live camera state');
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
    assertNonEmptyString(snapshot.label, `${context} label`);
    assertNullableString(snapshot.fieldKey, `${context} fieldKey`);
    if (
      snapshot.fieldKind !== null
      && snapshot.fieldKind !== 'category'
      && snapshot.fieldKind !== 'continuous'
    ) {
      throw new TypeError(`${context} fieldKind must be category, continuous, or null.`);
    }
    if ((snapshot.fieldKey === null) !== (snapshot.fieldKind === null)) {
      throw new TypeError(`${context} fieldKey and fieldKind must both be null or both be present.`);
    }
    assertSnapshotMeta(snapshot.meta, `${context} meta`);
    requireRepresentationRef(snapshot.embedding);
    assertCameraState(snapshot.cameraState, `${context} camera state`);
    assertActiveFieldsState(snapshot.activeFields);
    if (snapshot.activeFields.activeFieldKey !== snapshot.fieldKey) {
      throw new TypeError(`${context} active field identity does not match its descriptor.`);
    }
    assertPlainRecord(snapshot.filters, `${context} filters`);
    validateActiveFieldsForState(state, snapshot.activeFields);
    validateFiltersForState(state, snapshot.filters);
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

function requireRestoreOwners({
  state,
  viewer,
  restoreFilters,
  restoreActiveFields,
  pushViewerState
}) {
  if (state === null || typeof state !== 'object') {
    throw new TypeError('Multiview restore requires the current DataState owner.');
  }
  if (viewer === null || typeof viewer !== 'object') {
    throw new TypeError('Multiview restore requires the current viewer owner.');
  }
  for (const method of [
    'applySnapshotConfigToView',
    'captureCurrentContext',
    'createViewFromSource',
    'getActiveViewId',
    'getDimensionManager',
    'getSnapshotPayload',
    'getViewDimensionLevel',
    'getViewEmbeddingRef',
    'getViewLayoutKey',
    'removeView',
    'restoreContext',
    'restoreViewEmbedding',
    'setActiveView',
    'setViewRepresentation',
    'viewFollowsDefault',
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
    'setViewLayout',
    'setViewCameraState'
  ]) {
    requireMethod(viewer, method, 'Multiview viewer owner');
  }
  for (const [fn, context] of [
    [restoreFilters, 'Multiview restoreFilters'],
    [restoreActiveFields, 'Multiview restoreActiveFields'],
    [pushViewerState, 'Multiview pushViewerState']
  ]) {
    if (typeof fn !== 'function') {
      throw new TypeError(`${context} must be a function.`);
    }
  }
}

export async function restoreMultiview(owners, multiview) {
  assertMultiviewState(owners.state, multiview);
  requireRestoreOwners(owners);
  const {
    state,
    viewer,
    restoreFilters,
    restoreActiveFields,
    pushViewerState
  } = owners;
  const dimensionManager = state.getDimensionManager();
  requireMethod(
    dimensionManager,
    'getViewLayout',
    'Multiview dimension owner'
  );

  // The graph rollback returns the live view to where this restore found it.
  // That pose is reachable by construction — the viewer reported it — whereas
  // the saved pose is exactly the one a failed replay may have just proven
  // unreachable, and re-asserting it from the rollback would only fail again.
  const priorCamerasLocked = viewer.getCamerasLocked();
  const priorLiveCameraState = cloneCameraState(
    viewer.getViewCameraState('live'),
    'Live camera state before multiview restore'
  );

  clearPublishedSnapshotViews({ state, viewer });
  viewer.setCamerasLocked(multiview.camerasLocked);
  viewer.setViewCameraState('live', multiview.liveCameraState);
  pushViewerState();

  const baseContext = state.captureCurrentContext();
  if (baseContext === null || typeof baseContext !== 'object') {
    throw new TypeError('Multiview captureCurrentContext() must return an object.');
  }
  // The live view's representation, and whether it follows its dimension's
  // default, are what the replay below changes; they come back with it.
  const baseLayoutKey = state.getViewLayoutKey('live');
  const baseFollowsDefault = state.viewFollowsDefault('live');
  const idMap = new Map();
  const createdIds = new Set();

  async function restoreBaseContext() {
    if (state.getActiveViewId() !== 'live') {
      const activeResult = state.setActiveView('live');
      if (activeResult !== 'live') {
        throw new Error(
          'Multiview base-context restoration could not reactivate the live view.'
        );
      }
    }
    await state.setViewRepresentation('live', baseLayoutKey, {
      followsDefault: baseFollowsDefault
    });
    state.restoreContext(baseContext);
    if (state.getActiveViewId() !== 'live') {
      throw new Error(
        'Multiview base-context restoration must reactivate the live view.'
      );
    }
    const restoredLayouts = [
      state.getViewLayoutKey('live'),
      dimensionManager.getViewLayout('live'),
      viewer.getViewLayoutKey('live')
    ];
    if (restoredLayouts.some(layoutKey => layoutKey !== baseLayoutKey)) {
      throw new Error(
        'Multiview base-context restoration did not restore the exact ' +
        'DataState, dimension-manager, and viewer representation.'
      );
    }
  }

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

  function restoreSavedLiveCamera() {
    applyLiveCamera(multiview.liveCameraState, 'saved live camera');
  }

  function restorePriorLiveCamera() {
    if (viewer.getCamerasLocked() !== priorCamerasLocked) {
      viewer.setCamerasLocked(priorCamerasLocked);
    }
    applyLiveCamera(priorLiveCameraState, 'live camera it started from');
  }

  let replayError = null;
  try {
    for (const snapshot of multiview.snapshots) {
      await restoreBaseContext();
      await restoreFilters(snapshot.filters);
      await restoreActiveFields(snapshot.activeFields);
      await state.restoreViewEmbedding('live', snapshot.embedding);
      if (
        JSON.stringify(state.getViewEmbeddingRef('live'))
          !== JSON.stringify(snapshot.embedding)
      ) {
        throw new Error(
          `Replayed snapshot "${snapshot.id}" did not restore its exact embedding.`
        );
      }
      const snapshotDimension = state.getViewDimensionLevel('live');
      pushViewerState();

      const sourceViewId = state.getActiveViewId();
      if (sourceViewId !== 'live') {
        throw new Error('Multiview snapshot replay must start from the live context.');
      }
      const payload = state.getSnapshotPayload();
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new TypeError('Multiview getSnapshotPayload() must return an object.');
      }
      if (
        payload.fieldKey !== snapshot.fieldKey
        || payload.fieldKind !== snapshot.fieldKind
        || payload.label !== snapshot.label
        || payload.dimensionLevel !== snapshotDimension
      ) {
        throw new Error(
          `Replayed snapshot "${snapshot.id}" does not match its saved descriptor.`
        );
      }
      assertArray(payload.filtersText, `Replayed snapshot "${snapshot.id}" filtersText`);
      if (
        payload.filtersText.length !== snapshot.meta.filtersText.length
        || payload.filtersText.some(
          (line, index) => line !== snapshot.meta.filtersText[index]
        )
      ) {
        throw new Error(`Replayed snapshot "${snapshot.id}" filter summary does not match.`);
      }

      const created = publishSnapshotView({
        state,
        viewer,
        config: {
          label: snapshot.label,
          fieldKey: snapshot.fieldKey,
          fieldKind: snapshot.fieldKind,
          colors: payload.colors,
          transparency: payload.transparency,
          centroidPositions: payload.centroidPositions,
          centroidColors: payload.centroidColors,
          sourceViewId,
          meta: {
            filtersText: [...snapshot.meta.filtersText]
          },
          dimensionLevel: snapshotDimension,
          cameraState: snapshot.cameraState
        }
      });
      const newId = assertSnapshotId(created.id, 'Created multiview snapshot id');
      if (createdIds.has(newId)) {
        throw new TypeError(`Viewer created duplicate snapshot id "${newId}".`);
      }
      createdIds.add(newId);
      idMap.set(snapshot.id, newId);
    }
  } catch (error) {
    replayError = error;
  }

  async function rollbackRestoredGraph(error) {
    const cleanupFailures = [];
    try {
      clearPublishedSnapshotViews({ state, viewer });
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    try {
      await restoreBaseContext();
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    try {
      restorePriorLiveCamera();
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
  if (replayError !== null) {
    await rollbackRestoredGraph(replayError);
  }

  try {
    await restoreBaseContext();
    restoreSavedLiveCamera();

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
    await rollbackRestoredGraph(error);
  }
}
