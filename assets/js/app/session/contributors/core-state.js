/**
 * @fileoverview Exact current core visualization session state.
 *
 * @module session/contributors/core-state
 */

import { createUiControlSerializer } from '../../state-serializer/ui-controls.js';
import {
  createFilterSerializer,
  serializeFiltersForFields,
  validateFiltersForState
} from '../../state-serializer/filters.js';
import {
  assertActiveFieldsState,
  restoreActiveFields,
  serializeActiveFields,
  syncFieldSelectsToActiveField,
  validateActiveFieldsForState
} from '../../state-serializer/active-fields.js';
import {
  assertMultiviewState,
  restoreMultiview
} from '../../state-serializer/multiview.js';
import {
  assertCameraState,
  cloneCameraState
} from '../../../rendering/camera-state-contract.js';
import {
  assertArray,
  assertBoolean,
  assertExactKeys,
  assertNonEmptyString,
  assertPlainRecord,
  assertSafeInteger,
  requireMethod
} from '../schema-contract.js';
import {
  getSessionRestoreSnapshot
} from '../session-context.js';

export const id = 'core-state';

const CORE_PAYLOAD_KEYS = [
  'camera',
  'liveDimensionLevel',
  'uiControls',
  'filters',
  'activeFields',
  'multiview'
];

function throwIfAborted(signal) {
  if (signal !== null && signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

function assertAbortSignal(signal) {
  if (
    signal !== null
    && (
      typeof signal !== 'object'
      || typeof signal.aborted !== 'boolean'
    )
  ) {
    throw new TypeError('Core-state abortSignal must be an AbortSignal or null.');
  }
  return signal;
}

function assertDimensionLevel(value, context) {
  return assertSafeInteger(value, context, { minimum: 1, maximum: 3 });
}

function assertFieldArray(data, context) {
  if (data === null || typeof data !== 'object' || !Array.isArray(data.fields)) {
    throw new TypeError(`${context} requires a field inventory.`);
  }
  return data.fields;
}

function serializeContextActiveFields(context, snapshotId) {
  const source = context.activeFieldSource;
  const obsFields = assertFieldArray(
    context.obsData,
    `Snapshot "${snapshotId}" obs data`
  );
  const varFields = assertFieldArray(
    context.varData,
    `Snapshot "${snapshotId}" var data`
  );
  if (source === null) {
    if (context.activeFieldIndex !== -1 || context.activeVarFieldIndex !== -1) {
      throw new TypeError(`Snapshot "${snapshotId}" null active source requires -1 indices.`);
    }
    return {
      activeFieldKey: null,
      activeFieldSource: null
    };
  }
  if (source !== 'obs' && source !== 'var') {
    throw new TypeError(`Snapshot "${snapshotId}" has unsupported activeFieldSource.`);
  }
  const index = source === 'obs'
    ? context.activeFieldIndex
    : context.activeVarFieldIndex;
  assertSafeInteger(index, `Snapshot "${snapshotId}" active field index`);
  const fields = source === 'obs' ? obsFields : varFields;
  if (index >= fields.length) {
    throw new RangeError(`Snapshot "${snapshotId}" active field index is out of range.`);
  }
  const field = fields[index];
  if (field === null || typeof field !== 'object' || field._isDeleted === true) {
    throw new TypeError(`Snapshot "${snapshotId}" active field is unavailable.`);
  }
  if (source === 'obs' && context.activeVarFieldIndex !== -1) {
    throw new TypeError(`Snapshot "${snapshotId}" obs source requires activeVarFieldIndex -1.`);
  }
  if (source === 'var' && context.activeFieldIndex !== -1) {
    throw new TypeError(`Snapshot "${snapshotId}" var source requires activeFieldIndex -1.`);
  }
  return assertActiveFieldsState({
    activeFieldKey: assertNonEmptyString(
      field.key,
      `Snapshot "${snapshotId}" active field key`
    ),
    activeFieldSource: source
  });
}

function assertSnapshotMeta(meta, snapshotId) {
  assertExactKeys(meta, ['filtersText'], `Snapshot "${snapshotId}" metadata`);
  assertArray(meta.filtersText, `Snapshot "${snapshotId}" filter summary`);
  for (const line of meta.filtersText) {
    if (typeof line !== 'string') {
      throw new TypeError(`Snapshot "${snapshotId}" filter summaries must be strings.`);
    }
  }
  return {
    filtersText: [...meta.filtersText]
  };
}

function serializeMultiviewDescriptors({
  state,
  viewer,
  camerasLocked,
  currentCamera
}) {
  requireMethod(viewer, 'getViewLayout', 'Core-state viewer');
  requireMethod(viewer, 'getSnapshotViews', 'Core-state viewer');
  requireMethod(viewer, 'getViewCameraState', 'Core-state viewer');
  if (!(state.viewContexts instanceof Map)) {
    throw new TypeError('Core-state capture requires the current viewContexts Map.');
  }
  const layout = viewer.getViewLayout();
  const viewerSnapshots = assertArray(
    viewer.getSnapshotViews(),
    'Current viewer snapshots'
  );
  const snapshots = viewerSnapshots.map((snapshot, index) => {
    if (snapshot === null || typeof snapshot !== 'object') {
      throw new TypeError(`Current viewer snapshot ${index} must be an object.`);
    }
    const snapshotId = assertNonEmptyString(
      snapshot.id,
      `Current viewer snapshot ${index} id`
    );
    const context = state.viewContexts.get(snapshotId);
    if (context === undefined || context === null || typeof context !== 'object') {
      throw new RangeError(`DataState context for snapshot "${snapshotId}" was not found.`);
    }
    const activeFields = serializeContextActiveFields(context, snapshotId);
    const fieldKey = snapshot.fieldKey;
    const fieldKind = snapshot.fieldKind;
    if (fieldKey !== activeFields.activeFieldKey) {
      throw new TypeError(`Snapshot "${snapshotId}" field identity differs from DataState.`);
    }
    if (
      (fieldKind === null && fieldKey !== null)
      || (
        fieldKind !== null
        && fieldKind !== 'category'
        && fieldKind !== 'continuous'
      )
    ) {
      throw new TypeError(`Snapshot "${snapshotId}" field kind is invalid.`);
    }
    return {
      id: snapshotId,
      label: assertNonEmptyString(
        snapshot.label,
        `Current viewer snapshot "${snapshotId}" label`
      ),
      fieldKey,
      fieldKind,
      meta: assertSnapshotMeta(snapshot.meta, snapshotId),
      dimensionLevel: assertDimensionLevel(
        context.dimensionLevel,
        `Snapshot "${snapshotId}" dimensionLevel`
      ),
      cameraState: camerasLocked
        ? cloneCameraState(
          currentCamera,
          `Locked snapshot session camera state for "${snapshotId}"`
        )
        : assertCameraState(
          viewer.getViewCameraState(snapshotId),
          `Snapshot session camera state for "${snapshotId}"`
        ),
      activeFields,
      filters: {
        ...serializeFiltersForFields(
          assertFieldArray(context.obsData, `Snapshot "${snapshotId}" obs data`),
          'obs'
        ),
        ...serializeFiltersForFields(
          assertFieldArray(context.varData, `Snapshot "${snapshotId}" var data`),
          'var'
        )
      }
    };
  });

  const multiview = {
    layout,
    camerasLocked,
    liveCameraState: camerasLocked
      ? cloneCameraState(currentCamera, 'Locked live-view session camera state')
      : assertCameraState(
        viewer.getViewCameraState('live'),
        'Live-view session camera state'
      ),
    snapshots
  };
  return assertMultiviewState(state, multiview);
}

function pushViewerState(state) {
  for (const method of [
    'updateOutlierQuantiles',
    'computeGlobalVisibility',
    '_pushColorsToViewer',
    '_pushTransparencyToViewer',
    '_pushCentroidsToViewer',
    'getCurrentOutlierThreshold'
  ]) {
    requireMethod(state, method, 'Core-state viewer synchronization owner');
  }
  state.updateOutlierQuantiles();
  state.computeGlobalVisibility();
  state._pushColorsToViewer();
  state._pushTransparencyToViewer();
  state._pushCentroidsToViewer();
}

function getOwners(ctx, operation) {
  if (ctx === null || typeof ctx !== 'object') {
    throw new TypeError(`Core-state ${operation} requires a session context.`);
  }
  if (ctx.state === null || typeof ctx.state !== 'object') {
    throw new TypeError(`Core-state ${operation} requires the current DataState owner.`);
  }
  if (ctx.viewer === null || typeof ctx.viewer !== 'object') {
    throw new TypeError(`Core-state ${operation} requires the current viewer owner.`);
  }
  if (
    ctx.sidebar === null
    || typeof ctx.sidebar !== 'object'
    || typeof ctx.sidebar.querySelectorAll !== 'function'
  ) {
    throw new TypeError(`Core-state ${operation} requires the current sidebar.`);
  }
  return {
    state: ctx.state,
    viewer: ctx.viewer,
    sidebar: ctx.sidebar
  };
}

function assertCorePayload(state, payload) {
  assertExactKeys(payload, CORE_PAYLOAD_KEYS, 'Core-state payload');
  assertCameraState(payload.camera, 'Restored session camera state');
  assertDimensionLevel(payload.liveDimensionLevel, 'Core-state liveDimensionLevel');
  assertPlainRecord(payload.uiControls, 'Core-state uiControls');
  validateFiltersForState(state, payload.filters);
  validateActiveFieldsForState(state, payload.activeFields);
  assertMultiviewState(state, payload.multiview);
  return payload;
}

export function capture(ctx) {
  const { state, viewer, sidebar } = getOwners(ctx, 'capture');
  for (const method of [
    'getCamerasLocked',
    'getCameraState'
  ]) {
    requireMethod(viewer, method, 'Core-state capture viewer');
  }
  requireMethod(state, 'getViewDimensionLevel', 'Core-state capture owner');
  const camerasLocked = viewer.getCamerasLocked();
  assertBoolean(camerasLocked, 'Core-state camerasLocked');
  const ui = createUiControlSerializer({ sidebar });
  const filters = createFilterSerializer({ state });
  const camera = cloneCameraState(
    viewer.getCameraState(),
    'Session camera state'
  );
  const payload = {
    camera,
    liveDimensionLevel: assertDimensionLevel(
      state.getViewDimensionLevel('live'),
      'Core-state live dimension'
    ),
    uiControls: ui.collectUIControls(),
    filters: filters.serializeFilters(),
    activeFields: serializeActiveFields(state),
    multiview: serializeMultiviewDescriptors({
      state,
      viewer,
      camerasLocked,
      currentCamera: camera
    })
  };
  assertCorePayload(state, payload);

  return [{
    id: 'core/state',
    contributorId: id,
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Core state',
    datasetDependent: true,
    payload
  }];
}

function requireElement(idValue) {
  const element = document.getElementById(idValue);
  if (element === null) {
    throw new TypeError(`Core-state restore requires current element "${idValue}".`);
  }
  return element;
}

function requireRestoreDom() {
  const elements = {
    dimensionSelect: requireElement('dimension-select'),
    renderModeSelect: requireElement('render-mode'),
    categoricalSelect: requireElement('categorical-field'),
    continuousSelect: requireElement('continuous-field'),
    geneSearch: requireElement('gene-expression-search'),
    outlierSlider: requireElement('outlier-filter'),
    outlierDisplay: requireElement('outlier-filter-display'),
    navigationSelect: requireElement('navigation-mode'),
    freeflyControls: requireElement('freefly-controls'),
    orbitControls: requireElement('orbit-controls'),
    planarControls: requireElement('planar-controls')
  };
  for (const panel of [
    elements.freeflyControls,
    elements.orbitControls,
    elements.planarControls
  ]) {
    if (panel.style === null || typeof panel.style !== 'object') {
      throw new TypeError('Core-state navigation panels require style owners.');
    }
  }
  return elements;
}

function assertSelectOption(select, value, context) {
  if (select.options === null || select.options === undefined) {
    throw new TypeError(`${context} requires an option inventory.`);
  }
  const hasOption = Array.from(select.options).some(option => option.value === value);
  if (!hasOption) {
    throw new RangeError(`${context} option "${value}" is unavailable.`);
  }
}

function publishRenderModeControl(select, value) {
  assertSelectOption(select, value, 'Render-mode selector');
  if (select.value === value) return;
  if (typeof select.dispatchEvent !== 'function') {
    throw new TypeError('Render-mode selector must support event dispatch.');
  }
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  if (select.value !== value) {
    throw new Error(`Render-mode selector rejected restored value "${value}".`);
  }
}

function getSavedRenderMode(uiControls) {
  if (!Object.hasOwn(uiControls, 'render-mode')) return null;
  const value = uiControls['render-mode'].value;
  if (value !== 'points' && value !== 'smoke') {
    throw new TypeError(
      'Core-state render-mode UI control must restore "points" or "smoke".'
    );
  }
  return value;
}

function syncDomainControls(state, viewer, dom) {
  syncFieldSelectsToActiveField(state);
  const threshold = state.getCurrentOutlierThreshold();
  if (
    typeof threshold !== 'number'
    || !Number.isFinite(threshold)
    || threshold < 0
    || threshold > 1
  ) {
    throw new TypeError('Current outlier threshold must be a finite value from 0 through 1.');
  }
  const percentage = Math.round(threshold * 100);
  dom.outlierSlider.value = String(percentage);
  dom.outlierDisplay.textContent = `${percentage}%`;

  const activeViewId = state.getActiveViewId();
  const dimensionLevel = assertDimensionLevel(
    state.getViewDimensionLevel(activeViewId),
    `Restored active view "${activeViewId}" dimension`
  );
  const dimensionValue = String(dimensionLevel);
  assertSelectOption(dom.dimensionSelect, dimensionValue, 'Dimension selector');
  dom.dimensionSelect.value = dimensionValue;

  const camera = assertCameraState(
    viewer.getCameraState(),
    'Restored active camera state'
  );
  assertSelectOption(dom.navigationSelect, camera.navigationMode, 'Navigation selector');
  dom.navigationSelect.value = camera.navigationMode;
  dom.freeflyControls.style.display = camera.navigationMode === 'free' ? 'block' : 'none';
  dom.orbitControls.style.display = camera.navigationMode === 'orbit' ? 'block' : 'none';
  dom.planarControls.style.display = camera.navigationMode === 'planar' ? 'block' : 'none';
}

async function applyCorePayload(ctx, payload, signalOverride) {
  const { state, viewer, sidebar } = getOwners(ctx, 'restore');
  for (const method of [
    'setDimensionLevel',
    'getViewDimensionLevel',
    'getActiveViewId',
    'setActiveView',
    '_notifyVisibilityChange',
    'updateFilteredCount',
    'updateFilterSummary',
    'getCurrentOutlierThreshold'
  ]) {
    requireMethod(state, method, 'Core-state restore owner');
  }
  for (const method of [
    'setNavigationMode',
    'setCameraState',
    'getCameraState'
  ]) {
    requireMethod(viewer, method, 'Core-state restore viewer');
  }
  const signal = assertAbortSignal(signalOverride);
  const ui = createUiControlSerializer({ sidebar });
  const filters = createFilterSerializer({ state });
  const dom = requireRestoreDom();
  const sessionState = assertCorePayload(state, payload);
  assertSelectOption(
    dom.dimensionSelect,
    String(sessionState.liveDimensionLevel),
    'Live dimension selector'
  );

  ui.validateUIControls(sessionState.uiControls);
  const savedRenderMode = getSavedRenderMode(sessionState.uiControls);
  if (
    savedRenderMode === 'smoke'
    && sessionState.multiview.snapshots.length > 0
  ) {
    throw new TypeError(
      'A smoke-mode session cannot contain kept multiview snapshots.'
    );
  }

  let restoreDeferredUiControls = () => {};
  if (savedRenderMode === null) {
    ui.restoreUIControls(sessionState.uiControls, { abortSignal: signal });
  } else {
    // Points is the neutral replay mode: it cannot allocate a smoke volume
    // from retiring state and it permits the saved snapshot graph to rebuild.
    publishRenderModeControl(dom.renderModeSelect, 'points');
    restoreDeferredUiControls = ui.restoreUIControls(
      sessionState.uiControls,
      {
        abortSignal: signal,
        deferControlIds: ['render-mode']
      }
    );
  }
  throwIfAborted(signal);

  const activeViewResult = state.setActiveView('live');
  if (activeViewResult !== 'live') {
    throw new Error('DataState rejected the live view before core-state restore.');
  }
  await state.setDimensionLevel(sessionState.liveDimensionLevel, {
    viewId: 'live'
  });
  if (state.getViewDimensionLevel('live') !== sessionState.liveDimensionLevel) {
    throw new Error('DataState did not apply the restored live dimension.');
  }
  throwIfAborted(signal);

  await filters.restoreFilters(sessionState.filters, { signal });
  throwIfAborted(signal);
  await restoreActiveFields(
    state,
    sessionState.activeFields,
    { signal }
  );
  throwIfAborted(signal);

  await restoreMultiview({
    state,
    viewer,
    restoreFilters: snapshotFilters => filters.restoreFilters(
      snapshotFilters,
      { signal }
    ),
    restoreActiveFields: activeFields => restoreActiveFields(
      state,
      activeFields,
      { signal }
    ),
    pushViewerState: () => pushViewerState(state)
  }, sessionState.multiview);
  throwIfAborted(signal);

  if (sessionState.multiview.camerasLocked) {
    const sessionCamera = assertCameraState(
      sessionState.camera,
      'Restored session camera state'
    );
    viewer.setNavigationMode(sessionCamera.navigationMode);
    viewer.setCameraState(sessionCamera);
  }

  pushViewerState(state);
  syncDomainControls(state, viewer, dom);
  state._notifyVisibilityChange();
  state.updateFilteredCount();
  state.updateFilterSummary();
  throwIfAborted(signal);
  restoreDeferredUiControls();
  throwIfAborted(signal);
}

function getFieldOverlayRollbackDependency(restoreTransaction) {
  let dependency;
  try {
    dependency = restoreTransaction.get('field-overlays/state');
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
  if (
    dependency === null
    || typeof dependency !== 'object'
    || typeof dependency.rollback !== 'function'
  ) {
    throw new TypeError(
      'Core-state rollback requires the field-overlay rollback owner.'
    );
  }
  return dependency.rollback;
}

export async function restore(ctx, _chunkMeta, payload) {
  const { state } = getOwners(ctx, 'restore');
  assertCorePayload(state, payload);
  const signal = assertAbortSignal(ctx.abortSignal);
  const restoreTransaction = ctx.restoreTransaction;
  if (
    restoreTransaction === null
    || typeof restoreTransaction !== 'object'
  ) {
    await applyCorePayload(ctx, payload, signal);
    return;
  }
  requireMethod(
    restoreTransaction,
    'register',
    'Core-state restore transaction'
  );

  const sharedSnapshot = getSessionRestoreSnapshot(ctx, 'core/state');
  const previousPayload = sharedSnapshot === undefined
    ? capture(ctx)[0].payload
    : structuredClone(sharedSnapshot);
  const rollbackFieldOverlay =
    getFieldOverlayRollbackDependency(restoreTransaction);
  let applied = false;
  restoreTransaction.register('core-state/state', {
    value: payload,
    prepare() {},
    commit() {},
    async rollback() {
      if (!applied) return;
      if (rollbackFieldOverlay !== null) {
        await rollbackFieldOverlay();
      }
      await applyCorePayload(ctx, previousPayload, null);
      applied = false;
    }
  });

  applied = true;
  await applyCorePayload(ctx, payload, signal);
}
