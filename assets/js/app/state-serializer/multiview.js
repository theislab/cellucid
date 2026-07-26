/**
 * @fileoverview Exact multiview snapshot graph restoration.
 *
 * @module state-serializer/multiview
 */

import { assertCameraState } from '../../rendering/camera-state-contract.js';
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
  assertSafeInteger,
  requireMethod
} from '../session/schema-contract.js';

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
  'dimensionLevel',
  'cameraState',
  'activeFields',
  'filters'
];

function assertDimensionLevel(value, context) {
  assertSafeInteger(value, context, { minimum: 1, maximum: 3 });
  return value;
}

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
    assertDimensionLevel(snapshot.dimensionLevel, `${context} dimensionLevel`);
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
    'clearSnapshotViews',
    'captureCurrentContext',
    'restoreContext',
    'getSnapshotPayload',
    'getActiveViewId',
    'createViewFromActive',
    'setDimensionLevel',
    'setActiveView'
  ]) {
    requireMethod(state, method, 'Multiview DataState owner');
  }
  for (const method of [
    'clearSnapshotViews',
    'setCamerasLocked',
    'setViewCameraState',
    'createSnapshotView',
    'setLiveViewHidden',
    'setViewLayout',
    'getCamerasLocked',
    'getViewCameraState',
    'setCameraState'
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

  viewer.clearSnapshotViews();
  state.clearSnapshotViews();
  viewer.setCamerasLocked(multiview.camerasLocked);
  if (!multiview.camerasLocked) {
    viewer.setViewCameraState('live', multiview.liveCameraState);
  }
  pushViewerState();

  const baseContext = state.captureCurrentContext();
  if (baseContext === null || typeof baseContext !== 'object') {
    throw new TypeError('Multiview captureCurrentContext() must return an object.');
  }
  const idMap = new Map();
  const createdIds = new Set();

  try {
    for (const snapshot of multiview.snapshots) {
      state.restoreContext(baseContext);
      await restoreFilters(snapshot.filters);
      await restoreActiveFields(snapshot.activeFields);
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
      ) {
        throw new Error(
          `Replayed snapshot "${snapshot.id}" does not match its saved field/label descriptor.`
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

      const created = viewer.createSnapshotView({
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
        dimensionLevel: snapshot.dimensionLevel,
        cameraState: snapshot.cameraState
      });
      const newId = assertSnapshotId(created.id, 'Created multiview snapshot id');
      if (createdIds.has(newId)) {
        throw new TypeError(`Viewer created duplicate snapshot id "${newId}".`);
      }
      createdIds.add(newId);
      state.createViewFromActive(newId);
      idMap.set(snapshot.id, newId);
      await state.setDimensionLevel(snapshot.dimensionLevel, {
        viewId: newId
      });
    }
  } finally {
    state.restoreContext(baseContext);
  }

  const savedActiveId = multiview.layout.activeId;
  const resolvedActiveId = savedActiveId === 'live'
    ? 'live'
    : idMap.get(savedActiveId);
  if (resolvedActiveId === undefined) {
    throw new Error(`Multiview active snapshot "${savedActiveId}" was not created.`);
  }

  viewer.setViewLayout(multiview.layout.mode, resolvedActiveId);
  viewer.setLiveViewHidden(multiview.layout.liveViewHidden);
  const activeResult = state.setActiveView(resolvedActiveId);
  if (activeResult !== resolvedActiveId) {
    throw new Error(`DataState rejected restored active view "${resolvedActiveId}".`);
  }

  if (!viewer.getCamerasLocked()) {
    const activeCamera = assertCameraState(
      viewer.getViewCameraState(resolvedActiveId),
      `Restored active camera for "${resolvedActiveId}"`
    );
    viewer.setCameraState(activeCamera);
  }
}
