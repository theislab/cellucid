/**
 * @fileoverview Split-view (small multiples) controls.
 *
 * Owns UI state for:
 * - Active view selection (live vs snapshot)
 * - View layout mode (grid vs single)
 * - Snapshot creation/removal and camera lock toggles
 * - Badge rendering (with per-view dimension + nav indicators)
 *
 * Cross-module refresh (field selectors, legends, filters) is delegated via
 * callbacks whenever the active view changes.
 *
 * @module ui/modules/view-controls
 */

import { getNotificationCenter } from '../../notification-center.js';

const LIVE_VIEW_ID = 'live';
const VIEW_LAYOUT_MODES = new Set(['grid', 'single']);
const RENDER_MODES = new Set(['points', 'smoke']);
const SUPPORTED_DIMENSIONS = new Set([1, 2, 3]);
const NAV_MODE_LABELS = Object.freeze({
  orbit: 'Orb',
  planar: 'Pan',
  free: 'Fly',
});
const NAV_MODE_CYCLE = Object.freeze(['orbit', 'planar', 'free']);

function requireViewId(viewId, label = 'View id') {
  if (typeof viewId !== 'string' || viewId.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return viewId;
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

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label} must be exactly true or false.`);
  }
  return value;
}

function requireDimension(value, label = 'Dimension') {
  if (!SUPPORTED_DIMENSIONS.has(value)) {
    throw new RangeError(`${label} must be exactly 1, 2, or 3.`);
  }
  return value;
}

function requireLayoutMode(value) {
  if (!VIEW_LAYOUT_MODES.has(value)) {
    throw new RangeError('View layout mode must be exactly "grid" or "single".');
  }
  return value;
}

function requireRenderMode(value) {
  if (!RENDER_MODES.has(value)) {
    throw new RangeError('Render mode must be exactly "points" or "smoke".');
  }
  return value;
}

function requireNavigationMode(value) {
  if (!Object.hasOwn(NAV_MODE_LABELS, value)) {
    throw new RangeError(
      `Navigation mode must be orbit, planar, or free; received ${String(value)}.`
    );
  }
  return value;
}

function requireNonEmptyText(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function describeError(error) {
  return error instanceof Error
    ? error.message
    : 'The operation rejected with a non-Error value.';
}

function requireTypedArray(value, Type, length, label) {
  if (!(value instanceof Type) || value.length !== length) {
    throw new TypeError(
      `${label} must be ${Type.name} with exactly ${length} entries.`
    );
  }
  return value;
}

function requireNullableTypedArray(value, Type, label) {
  if (value !== null && !(value instanceof Type)) {
    throw new TypeError(`${label} must be ${Type.name} or null.`);
  }
  return value;
}

function requireSnapshotPayload(payload) {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    throw new TypeError('Snapshot payload must be one object.');
  }
  if (!Number.isSafeInteger(payload.pointCount) || payload.pointCount <= 0) {
    throw new RangeError(
      'A kept view requires a positive safe-integer point count.'
    );
  }
  const pointCount = payload.pointCount;
  requireNonEmptyText(payload.label, 'Snapshot label');
  if (
    payload.fieldKey !== null &&
    (typeof payload.fieldKey !== 'string' || payload.fieldKey.length === 0)
  ) {
    throw new TypeError('Snapshot fieldKey must be a non-empty string or null.');
  }
  if (
    payload.fieldKind !== null &&
    payload.fieldKind !== 'category' &&
    payload.fieldKind !== 'continuous'
  ) {
    throw new TypeError(
      'Snapshot fieldKind must be category, continuous, or null.'
    );
  }
  if ((payload.fieldKey === null) !== (payload.fieldKind === null)) {
    throw new TypeError(
      'Snapshot fieldKey and fieldKind must both be null or both be present.'
    );
  }
  requireTypedArray(
    payload.colors,
    Uint8Array,
    pointCount * 4,
    'Snapshot colors'
  );
  requireTypedArray(
    payload.transparency,
    Float32Array,
    pointCount,
    'Snapshot transparency'
  );
  requireTypedArray(
    payload.outlierQuantiles,
    Float32Array,
    pointCount,
    'Snapshot outlier quantiles'
  );
  requireNullableTypedArray(
    payload.centroidPositions,
    Float32Array,
    'Snapshot centroid positions'
  );
  requireNullableTypedArray(
    payload.centroidColors,
    Uint8Array,
    'Snapshot centroid colors'
  );
  requireNullableTypedArray(
    payload.centroidOutliers,
    Float32Array,
    'Snapshot centroid outliers'
  );
  const centroidCount = payload.centroidPositions === null
    ? 0
    : payload.centroidPositions.length / 3;
  if (!Number.isInteger(centroidCount)) {
    throw new TypeError(
      'Snapshot centroid positions must contain complete XYZ triples.'
    );
  }
  if (
    (payload.centroidPositions === null) !==
      (payload.centroidColors === null) ||
    (payload.centroidPositions === null) !==
      (payload.centroidOutliers === null)
  ) {
    throw new TypeError(
      'Snapshot centroid positions, colors, and outliers must be published together.'
    );
  }
  if (
    payload.centroidColors !== null &&
    payload.centroidColors.length !== centroidCount * 4
  ) {
    throw new TypeError(
      'Snapshot centroid colors must contain one RGBA tuple per centroid.'
    );
  }
  if (
    payload.centroidOutliers !== null &&
    payload.centroidOutliers.length !== centroidCount
  ) {
    throw new TypeError(
      'Snapshot centroid outliers must contain one value per centroid.'
    );
  }
  if (
    typeof payload.outlierThreshold !== 'number' ||
    !Number.isFinite(payload.outlierThreshold) ||
    payload.outlierThreshold < 0 ||
    payload.outlierThreshold > 1
  ) {
    throw new RangeError(
      'Snapshot outlier threshold must be finite and between 0 and 1.'
    );
  }
  if (
    !Array.isArray(payload.filtersText) ||
    payload.filtersText.some(line => typeof line !== 'string')
  ) {
    throw new TypeError('Snapshot filtersText must be an array of strings.');
  }
  requireDimension(payload.dimensionLevel, 'Snapshot dimension');
  return payload;
}

function requireSnapshotInventory(viewer) {
  const snapshots = viewer.getSnapshotViews();
  if (!Array.isArray(snapshots)) {
    throw new TypeError('Viewer snapshot inventory must be an array.');
  }
  const ids = new Set();
  for (const snapshot of snapshots) {
    if (
      snapshot === null ||
      typeof snapshot !== 'object' ||
      Array.isArray(snapshot)
    ) {
      throw new TypeError('Every viewer snapshot must be an object.');
    }
    const id = requireViewId(snapshot.id, 'Snapshot id');
    requireNonEmptyText(snapshot.label, `Snapshot "${id}" label`);
    if (ids.has(id)) {
      throw new TypeError(`Viewer published duplicate snapshot id "${id}".`);
    }
    ids.add(id);
  }
  return snapshots;
}

/**
 * @typedef {object} ViewCallbacks
 * @property {(viewId: string) => void} onActiveViewChanged
 * @property {(viewId: string, nextDim: number) => Promise<void>} onCycleViewDimension
 * @property {(viewId: string) => void} onNavigationUiSyncRequested
 */

export function initViewControls({ state, viewer, dom, renderDom, callbacks }) {
  for (const methodName of [
    'clearSnapshotViews',
    'createViewFromActive',
    'getActiveViewId',
    'getAvailableDimensions',
    'getDimensionManager',
    'getSnapshotPayload',
    'getViewDimensionLevel',
    'removeView',
    'setActiveView',
    'syncSnapshotContexts',
  ]) {
    requireMethod(state, methodName, 'View-control state');
  }
  for (const methodName of [
    'clearSnapshotViews',
    'createSnapshotView',
    'getCamerasLocked',
    'getFocusedViewId',
    'getLiveViewHidden',
    'getLiveViewLabel',
    'getSnapshotViews',
    'getViewCameraState',
    'getViewNavigationMode',
    'removeSnapshotView',
    'setCamerasLocked',
    'setLiveViewHidden',
    'setNavigationMode',
    'setViewFocusHandler',
    'setViewLayout',
    'setViewNavigationMode',
  ]) {
    requireMethod(viewer, methodName, 'View-control viewer');
  }
  for (const callbackName of [
    'onActiveViewChanged',
    'onCycleViewDimension',
    'onNavigationUiSyncRequested',
  ]) {
    if (
      callbacks === null ||
      typeof callbacks !== 'object' ||
      typeof callbacks[callbackName] !== 'function'
    ) {
      throw new TypeError(
        `View controls require callbacks.${callbackName}().`
      );
    }
  }
  if (
    dom === null ||
    typeof dom !== 'object' ||
    renderDom === null ||
    typeof renderDom !== 'object'
  ) {
    throw new TypeError('View controls require exact DOM records.');
  }
  if (!(dom.controls instanceof HTMLElement)) {
    throw new TypeError('View controls require the controls element.');
  }
  const ownerDocument = dom.controls.ownerDocument;
  const domEntries = [
    ['keep view button', dom.keepViewBtn, HTMLButtonElement],
    ['clear button', dom.clearBtn, HTMLButtonElement],
    ['camera lock button', dom.cameraLockBtn, HTMLButtonElement],
    ['layout selector', dom.layoutModeSelect, HTMLSelectElement],
    ['badges box', dom.badgesBox, HTMLElement],
    ['badges list', dom.badgesList, HTMLElement],
    ['render mode selector', renderDom.renderModeSelect, HTMLSelectElement],
  ];
  for (const [label, element, ElementType] of domEntries) {
    if (!(element instanceof ElementType)) {
      throw new TypeError(`View controls require the ${label}.`);
    }
    if (element.ownerDocument !== ownerDocument) {
      throw new TypeError(
        'View-control elements must belong to one document.'
      );
    }
  }

  const splitKeepViewBtn = dom.keepViewBtn;
  const splitClearBtn = dom.clearBtn;
  const cameraLockBtn = dom.cameraLockBtn;
  const viewLayoutModeSelect = dom.layoutModeSelect;
  const splitViewBadgesBox = dom.badgesBox;
  const splitViewBadges = dom.badgesList;
  const renderModeSelect = renderDom.renderModeSelect;

  let activeViewId = requireViewId(state.getActiveViewId(), 'Active view id');
  let viewLayoutMode = requireLayoutMode(viewLayoutModeSelect.value);
  let liveViewHidden = requireBoolean(
    viewer.getLiveViewHidden(),
    'Viewer live-view visibility'
  );

  function reportUiFailure(action, error) {
    getNotificationCenter().error(
      `${action}: ${describeError(error)}`,
      { category: 'render', duration: 10000 }
    );
  }

  function runUiAction(action, operation) {
    try {
      return operation();
    } catch (error) {
      reportUiFailure(action, error);
      return false;
    }
  }

  function requireCurrentInventory() {
    const snapshots = requireSnapshotInventory(viewer);
    const validIds = new Set([
      LIVE_VIEW_ID,
      ...snapshots.map(snapshot => snapshot.id),
    ]);
    if (!validIds.has(activeViewId)) {
      throw new RangeError(
        `Active view "${activeViewId}" is not in the viewer inventory.`
      );
    }
    if (liveViewHidden && activeViewId === LIVE_VIEW_ID) {
      throw new RangeError('A hidden live view cannot be the active view.');
    }
    return snapshots;
  }

  function pushViewLayoutToViewer() {
    requireLayoutMode(viewLayoutMode);
    requireCurrentInventory();
    viewer.setViewLayout(viewLayoutMode, activeViewId);
  }

  function syncActiveViewSelectOptions() {
    requireCurrentInventory();
  }

  function syncActiveViewToState() {
    const publishedViewId = state.setActiveView(activeViewId);
    if (publishedViewId !== activeViewId) {
      throw new Error(
        `State published active view "${String(publishedViewId)}" instead of "${activeViewId}".`
      );
    }
    callbacks.onActiveViewChanged(activeViewId);
  }

  function snapshotIds(snapshots = requireSnapshotInventory(viewer)) {
    return snapshots.map(snapshot => snapshot.id);
  }

  function syncSnapshotContexts() {
    state.syncSnapshotContexts(snapshotIds());
  }

  function removeSnapshot(snapshotId) {
    const exactId = requireViewId(snapshotId, 'Removed snapshot id');
    const before = requireSnapshotInventory(viewer);
    if (!before.some(snapshot => snapshot.id === exactId)) {
      throw new RangeError(`Snapshot "${exactId}" does not exist.`);
    }
    viewer.removeSnapshotView(exactId);
    const after = requireSnapshotInventory(viewer);
    if (after.some(snapshot => snapshot.id === exactId)) {
      throw new Error(`Viewer did not remove snapshot "${exactId}".`);
    }
    state.removeView(exactId);
    state.syncSnapshotContexts(snapshotIds(after));
    liveViewHidden = requireBoolean(
      viewer.getLiveViewHidden(),
      'Viewer live-view visibility'
    );
    return after;
  }

  let dimensionBadgeBusy = false;
  function createDimensionIndicator(viewId, currentDim) {
    const availableDims = state.getAvailableDimensions();
    if (
      !Array.isArray(availableDims) ||
      availableDims.some(dimension => !SUPPORTED_DIMENSIONS.has(dimension)) ||
      new Set(availableDims).size !== availableDims.length
    ) {
      throw new TypeError(
        'Available dimensions must be unique integers 1, 2, or 3.'
      );
    }
    const exactViewId = requireViewId(viewId);
    requireDimension(currentDim, `View "${exactViewId}" dimension`);
    if (
      availableDims.length > 0 &&
      !availableDims.includes(currentDim)
    ) {
      throw new RangeError(
        `View "${exactViewId}" uses unavailable dimension ${currentDim}D.`
      );
    }
    const usableDims = [...availableDims];
    if (usableDims.length <= 1) return null;

    const dimIndicator = ownerDocument.createElement('span');
    dimIndicator.className = 'split-badge-dim';
    dimIndicator.textContent = `${currentDim}D`;
    dimIndicator.title = 'Click to cycle dimension (1D/2D/3D)';
    dimIndicator.dataset.viewId = exactViewId;
    dimIndicator.setAttribute('role', 'button');
    dimIndicator.setAttribute('tabindex', '0');

    const cycleDimension = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (dimensionBadgeBusy) return;

      const targetViewId = requireViewId(
        e.currentTarget.dataset.viewId,
        'Dimension badge view id'
      );
      const freshCurrentDim = requireDimension(
        state.getViewDimensionLevel(targetViewId),
        `View "${targetViewId}" dimension`
      );
      const sortedDims = [...usableDims].sort((a, b) => b - a);
      const currentIdx = sortedDims.indexOf(freshCurrentDim);
      if (currentIdx < 0) {
        throw new RangeError(
          `View "${targetViewId}" dimension is not available.`
        );
      }
      const nextIdx = (currentIdx + 1) % sortedDims.length;
      const nextDim = sortedDims[nextIdx];

      dimensionBadgeBusy = true;
      dimIndicator.setAttribute('aria-disabled', 'true');
      try {
        await callbacks.onCycleViewDimension(targetViewId, nextDim);
        dimIndicator.removeAttribute('aria-invalid');
        renderSplitViewBadges();
      } catch (error) {
        dimIndicator.setAttribute('aria-invalid', 'true');
        dimIndicator.title =
          `Dimension change failed: ${describeError(error)}`;
      } finally {
        dimensionBadgeBusy = false;
        dimIndicator.removeAttribute('aria-disabled');
      }
    };
    dimIndicator.addEventListener('click', event => {
      void cycleDimension(event).catch(error => {
        reportUiFailure('Dimension change failed', error);
      });
    });
    dimIndicator.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        void cycleDimension(event).catch(error => {
          reportUiFailure('Dimension change failed', error);
        });
      }
    });

    return dimIndicator;
  }

  function createNavigationIndicator(viewId, currentMode) {
    const exactViewId = requireViewId(viewId);
    const exactMode = requireNavigationMode(currentMode);
    const camerasLocked = requireBoolean(
      viewer.getCamerasLocked(),
      'Viewer camera lock'
    );
    if (camerasLocked) return null;

    const navIndicator = ownerDocument.createElement('span');
    navIndicator.className = 'split-badge-nav';
    navIndicator.textContent = NAV_MODE_LABELS[exactMode];
    navIndicator.title = 'Click to cycle navigation mode (Orbit/Planar/Free-fly)';
    navIndicator.dataset.viewId = exactViewId;
    navIndicator.setAttribute('role', 'button');
    navIndicator.setAttribute('tabindex', '0');

    const cycleNavigation = (e) => {
      e.preventDefault();
      e.stopPropagation();

      const targetViewId = requireViewId(
        e.currentTarget.dataset.viewId,
        'Navigation badge view id'
      );
      const freshCurrentMode = requireNavigationMode(
        viewer.getViewNavigationMode(targetViewId)
      );

      const currentIdx = NAV_MODE_CYCLE.indexOf(freshCurrentMode);
      const nextIdx = (currentIdx + 1) % NAV_MODE_CYCLE.length;
      const nextMode = NAV_MODE_CYCLE[nextIdx];

      const focusedId = requireViewId(
        viewer.getFocusedViewId(),
        'Focused view id'
      );
      const isFocusedView = targetViewId === focusedId;

      if (isFocusedView) {
        viewer.setNavigationMode(nextMode);
      } else {
        viewer.setViewNavigationMode(targetViewId, nextMode);
      }

      renderSplitViewBadges();
      if (isFocusedView) {
        callbacks.onNavigationUiSyncRequested(targetViewId);
      }
    };
    navIndicator.addEventListener('click', event => {
      runUiAction('Navigation change failed', () => cycleNavigation(event));
    });
    navIndicator.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        runUiAction('Navigation change failed', () => cycleNavigation(event));
      }
    });

    return navIndicator;
  }

  function renderSplitViewBadges() {
    splitViewBadges.innerHTML = '';
    const snapshots = requireCurrentInventory();

    let badgeIndex = 1;

    if (!liveViewHidden) {
      const liveLabel = requireNonEmptyText(
        viewer.getLiveViewLabel(),
        'Live-view label'
      );

      const liveBadge = ownerDocument.createElement('div');
      liveBadge.className = 'split-badge';
      if (activeViewId === LIVE_VIEW_ID) {
        liveBadge.classList.add('active');
      }

      const camerasLocked = requireBoolean(
        viewer.getCamerasLocked(),
        'Viewer camera lock'
      );
      const focusedId = requireViewId(
        viewer.getFocusedViewId(),
        'Focused view id'
      );
      if (!camerasLocked && focusedId === LIVE_VIEW_ID) {
        liveBadge.classList.add('active-camera');
      }

      liveBadge.addEventListener('click', () => {
        runUiAction('View selection failed', () => {
          activeViewId = LIVE_VIEW_ID;
          syncActiveViewToState();
          pushViewLayoutToViewer();
          renderSplitViewBadges();
          callbacks.onNavigationUiSyncRequested(LIVE_VIEW_ID);
        });
      });

      const livePill = ownerDocument.createElement('span');
      livePill.className = 'split-badge-pill';
      livePill.textContent = String(badgeIndex);

      const liveCameraIndicator = ownerDocument.createElement('span');
      liveCameraIndicator.className = 'split-badge-camera';
      liveCameraIndicator.textContent = '\u2316';

      const liveText = ownerDocument.createElement('span');
      liveText.className = 'split-badge-label';
      liveText.textContent = liveLabel;

      const liveDim = requireDimension(
        state.getViewDimensionLevel(LIVE_VIEW_ID),
        'Live-view dimension'
      );
      const liveDimIndicator = createDimensionIndicator(LIVE_VIEW_ID, liveDim);

      const liveNavMode = requireNavigationMode(
        viewer.getViewNavigationMode(LIVE_VIEW_ID)
      );
      const liveNavIndicator = createNavigationIndicator(LIVE_VIEW_ID, liveNavMode);

      if (snapshots.length > 0) {
        const liveRemoveBtn = ownerDocument.createElement('button');
        liveRemoveBtn.type = 'button';
        liveRemoveBtn.className = 'split-badge-remove';
        liveRemoveBtn.title = 'Remove this view';
        liveRemoveBtn.textContent = '×';
        liveRemoveBtn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        liveRemoveBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          runUiAction('View removal failed', () => {
            const currentSnapshots = requireSnapshotInventory(viewer);
            if (currentSnapshots.length === 0) {
              throw new Error('The live-view removal control requires a snapshot.');
            }

            if (currentSnapshots.length === 1) {
              removeSnapshot(currentSnapshots[0].id);
              activeViewId = LIVE_VIEW_ID;
              syncActiveViewToState();
              pushViewLayoutToViewer();
            } else {
              if (activeViewId === LIVE_VIEW_ID) {
                activeViewId = currentSnapshots[0].id;
                syncActiveViewToState();
                pushViewLayoutToViewer();
              }
              viewer.setLiveViewHidden(true);
              liveViewHidden = true;
            }
            renderSplitViewBadges();
            updateSplitViewUI();
          });
        });

        liveBadge.appendChild(livePill);
        liveBadge.appendChild(liveCameraIndicator);
        liveBadge.appendChild(liveText);
        if (liveDimIndicator) liveBadge.appendChild(liveDimIndicator);
        if (liveNavIndicator) liveBadge.appendChild(liveNavIndicator);
        liveBadge.appendChild(liveRemoveBtn);
      } else {
        liveBadge.appendChild(livePill);
        liveBadge.appendChild(liveCameraIndicator);
        liveBadge.appendChild(liveText);
        if (liveDimIndicator) liveBadge.appendChild(liveDimIndicator);
        if (liveNavIndicator) liveBadge.appendChild(liveNavIndicator);
      }

      splitViewBadges.appendChild(liveBadge);
      badgeIndex++;
    }

    snapshots.forEach((snap) => {
      const badge = ownerDocument.createElement('div');
      badge.className = 'split-badge';
      const snapId = snap.id;
      if (snapId === activeViewId) {
        badge.classList.add('active');
      }

      const camerasLockedSnap = requireBoolean(
        viewer.getCamerasLocked(),
        'Viewer camera lock'
      );
      const focusedIdSnap = requireViewId(
        viewer.getFocusedViewId(),
        'Focused view id'
      );
      if (!camerasLockedSnap && focusedIdSnap === snapId) {
        badge.classList.add('active-camera');
      }

      badge.addEventListener('click', () => {
        runUiAction('View selection failed', () => {
          activeViewId = snapId;
          syncActiveViewToState();
          pushViewLayoutToViewer();
          renderSplitViewBadges();
          callbacks.onNavigationUiSyncRequested(snapId);
        });
      });

      const pill = ownerDocument.createElement('span');
      pill.className = 'split-badge-pill';
      pill.textContent = String(badgeIndex);

      const cameraIndicator = ownerDocument.createElement('span');
      cameraIndicator.className = 'split-badge-camera';
      cameraIndicator.textContent = '\u2316';

      const text = ownerDocument.createElement('span');
      text.className = 'split-badge-label';
      text.textContent = requireNonEmptyText(
        snap.label,
        `Snapshot "${snapId}" label`
      );

      const snapDim = requireDimension(
        state.getViewDimensionLevel(snapId),
        `Snapshot "${snapId}" dimension`
      );
      const snapDimIndicator = createDimensionIndicator(snapId, snapDim);

      const snapNavMode = requireNavigationMode(
        viewer.getViewNavigationMode(snapId)
      );
      const snapNavIndicator = createNavigationIndicator(snapId, snapNavMode);

      badge.appendChild(pill);
      badge.appendChild(cameraIndicator);
      badge.appendChild(text);
      if (snapDimIndicator) badge.appendChild(snapDimIndicator);
      if (snapNavIndicator) badge.appendChild(snapNavIndicator);

      if (!liveViewHidden || snapshots.length > 1) {
        const removeBtn = ownerDocument.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'split-badge-remove';
        removeBtn.title = 'Remove this view';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        removeBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          runUiAction('Snapshot removal failed', () => {
            const removedActiveView = snapId === activeViewId;
            const remainingSnaps = removeSnapshot(snapId);
            const activeStillExists =
              activeViewId === LIVE_VIEW_ID ||
              remainingSnaps.some(snapshot => snapshot.id === activeViewId);
            if (removedActiveView || !activeStillExists) {
              if (liveViewHidden) {
                if (remainingSnaps.length === 0) {
                  throw new Error(
                    'Viewer kept the live view hidden without any snapshot.'
                  );
                }
                activeViewId = remainingSnaps[0].id;
              } else {
                activeViewId = LIVE_VIEW_ID;
              }
              syncActiveViewToState();
              pushViewLayoutToViewer();
            }
            renderSplitViewBadges();
            updateSplitViewUI();
          });
        });
        badge.appendChild(removeBtn);
      }

      splitViewBadges.appendChild(badge);
      badgeIndex++;
    });

    syncActiveViewSelectOptions();
  }

  function updateCameraLockUI() {
    const locked = requireBoolean(
      viewer.getCamerasLocked(),
      'Viewer camera lock'
    );
    cameraLockBtn.setAttribute('aria-pressed', locked ? 'true' : 'false');
    cameraLockBtn.textContent = locked ? 'Locked Cam' : 'Unlocked Cam';
    cameraLockBtn.title = locked ? 'Cameras linked (click to unlink)' : 'Cameras independent (click to link)';
  }

  function updateSplitViewUI() {
    const renderMode = requireRenderMode(renderModeSelect.value);
    const modeIsPoints = renderMode === 'points';
    const snapshots = requireCurrentInventory();
    state.syncSnapshotContexts(snapshotIds(snapshots));

    const hasSnaps = snapshots.length > 0;
    const hasMultipleViews = snapshots.length > 0;
    splitViewBadgesBox.style.display = hasMultipleViews ? '' : 'none';
    syncActiveViewSelectOptions();

    splitKeepViewBtn.disabled = !modeIsPoints;
    splitKeepViewBtn.title = modeIsPoints
      ? 'Freeze the current view as a panel'
      : 'Switch to “Points” mode to keep views';
    splitClearBtn.disabled = !hasSnaps;
    cameraLockBtn.disabled = !hasMultipleViews;
    // Keep the button label/aria state in sync in case camera lock is toggled
    // programmatically (e.g., session restore).
    updateCameraLockUI();
    if (!hasMultipleViews) {
      cameraLockBtn.title = 'Add a kept view to link cameras';
    }

    if (!modeIsPoints) {
      viewLayoutMode = 'single';
      viewLayoutModeSelect.value = 'single';
      if (liveViewHidden) {
        liveViewHidden = false;
        viewer.setLiveViewHidden(false);
      }
      if (activeViewId !== LIVE_VIEW_ID) {
        activeViewId = LIVE_VIEW_ID;
      }
    } else {
      viewLayoutMode = requireLayoutMode(viewLayoutModeSelect.value);
    }
    viewLayoutModeSelect.disabled = !modeIsPoints;

    syncActiveViewToState();
    pushViewLayoutToViewer();
  }

  function handleKeepView() {
    if (requireRenderMode(renderModeSelect.value) !== 'points') {
      throw new Error('Kept views are available only in Points render mode.');
    }
    const sourceViewId = activeViewId;
    const sourceLayoutMode = viewLayoutMode;
    const payload = requireSnapshotPayload(state.getSnapshotPayload());
    const dimensionManager = state.getDimensionManager();
    requireMethod(
      dimensionManager,
      'copyViewDimension',
      'Dimension manager'
    );
    let createdId = null;
    let stateContextCreated = false;
    try {
      const snapshotConfig = {
        label: payload.label,
        fieldKey: payload.fieldKey,
        fieldKind: payload.fieldKind,
        colors: payload.colors,
        transparency: payload.transparency,
        centroidPositions: payload.centroidPositions,
        centroidColors: payload.centroidColors,
        dimensionLevel: payload.dimensionLevel,
        sourceViewId,
        meta: { filtersText: [...payload.filtersText] },
        cameraState: viewer.getViewCameraState(sourceViewId),
      };

      const created = viewer.createSnapshotView(snapshotConfig);
      if (
        created === null ||
        typeof created !== 'object' ||
        Array.isArray(created)
      ) {
        throw new TypeError(
          'Viewer snapshot creation must return an identity record.'
        );
      }
      createdId = requireViewId(created.id, 'Created snapshot id');
      const createdLabel = requireNonEmptyText(
        created.label,
        'Created snapshot label'
      );
      if (createdLabel !== payload.label) {
        throw new Error(
          'Viewer changed the exact snapshot label during publication.'
        );
      }
      const publishedSnapshot = requireSnapshotInventory(viewer)
        .find(snapshot => snapshot.id === createdId);
      if (publishedSnapshot === undefined) {
        throw new Error(
          `Viewer did not publish created snapshot "${createdId}".`
        );
      }

      state.createViewFromActive(createdId);
      stateContextCreated = true;
      dimensionManager.copyViewDimension(sourceViewId, createdId);
      if (
        state.getViewDimensionLevel(createdId) !== payload.dimensionLevel
      ) {
        throw new Error(
          `State published the wrong dimension for snapshot "${createdId}".`
        );
      }
      syncSnapshotContexts();
      activeViewId = createdId;
      viewLayoutMode = 'grid';
      viewLayoutModeSelect.value = 'grid';

      syncActiveViewToState();
      renderSplitViewBadges();
      updateSplitViewUI();
      return true;
    } catch (error) {
      const rollbackFailures = [];
      const rollback = operation => {
        try {
          operation();
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      };
      if (createdId !== null) {
        if (stateContextCreated) {
          rollback(() => state.removeView(createdId));
        }
        let snapshotStillPublished = false;
        rollback(() => {
          snapshotStillPublished = requireSnapshotInventory(viewer)
            .some(snapshot => snapshot.id === createdId);
        });
        if (snapshotStillPublished) {
          rollback(() => viewer.removeSnapshotView(createdId));
        }
        rollback(() => syncSnapshotContexts());
      }
      activeViewId = sourceViewId;
      viewLayoutMode = sourceLayoutMode;
      viewLayoutModeSelect.value = sourceLayoutMode;
      rollback(() => {
        const restoredViewId = state.setActiveView(sourceViewId);
        if (restoredViewId !== sourceViewId) {
          throw new Error(
            `State did not restore source view "${sourceViewId}".`
          );
        }
      });
      rollback(() => viewer.setViewLayout(sourceLayoutMode, sourceViewId));
      const reportedError = rollbackFailures.length === 0
        ? error
        : new AggregateError(
            [error, ...rollbackFailures],
            'Kept-view creation failed and rollback was incomplete.'
          );
      reportUiFailure('Keep view failed', reportedError);
      return false;
    }
  }

  function handleClearViews() {
    activeViewId = LIVE_VIEW_ID;
    liveViewHidden = false;
    viewLayoutMode = 'grid';
    viewLayoutModeSelect.value = 'grid';
    viewer.clearSnapshotViews();
    state.clearSnapshotViews();
    syncActiveViewToState();
    renderSplitViewBadges();
    updateSplitViewUI();
  }

  function focusViewFromOverlay(viewId) {
    const newViewId = requireViewId(viewId, 'Focused view id');
    const snapshots = requireSnapshotInventory(viewer);
    if (
      newViewId !== LIVE_VIEW_ID &&
      !snapshots.some(snapshot => snapshot.id === newViewId)
    ) {
      throw new RangeError(`Focused view "${newViewId}" does not exist.`);
    }
    if (liveViewHidden && newViewId === LIVE_VIEW_ID) {
      throw new RangeError('A hidden live view cannot receive focus.');
    }
    const viewChanged = activeViewId !== newViewId;
    activeViewId = newViewId;

    if (viewChanged) {
      const publishedViewId = state.setActiveView(newViewId);
      if (publishedViewId !== newViewId) {
        throw new Error(
          `State did not publish focused view "${newViewId}".`
        );
      }
    }

    syncActiveViewSelectOptions();
    renderSplitViewBadges();
    updateSplitViewUI();

    if (viewChanged) {
      callbacks.onActiveViewChanged(newViewId);
      callbacks.onNavigationUiSyncRequested(newViewId);
    }
  }

  viewer.setViewFocusHandler((viewId) => {
    runUiAction(
      'View focus failed',
      () => focusViewFromOverlay(viewId)
    );
  });

  splitKeepViewBtn.addEventListener('click', () => {
    runUiAction('Keep view failed', handleKeepView);
  });
  splitClearBtn.addEventListener('click', () => {
    runUiAction('Clear views failed', handleClearViews);
  });
  cameraLockBtn.addEventListener('click', () => {
    runUiAction('Camera lock change failed', () => {
      const newLocked = !requireBoolean(
        viewer.getCamerasLocked(),
        'Viewer camera lock'
      );
      viewer.setCamerasLocked(newLocked);
      updateCameraLockUI();
      renderSplitViewBadges();
      callbacks.onNavigationUiSyncRequested(activeViewId);
    });
  });
  updateCameraLockUI();
  viewLayoutModeSelect.addEventListener('change', () => {
    runUiAction('View layout change failed', () => {
      viewLayoutMode = requireLayoutMode(viewLayoutModeSelect.value);
      pushViewLayoutToViewer();
      renderSplitViewBadges();
      updateSplitViewUI();
    });
  });

  renderSplitViewBadges();
  updateSplitViewUI();

  function syncFromStateAndViewer() {
    activeViewId = requireViewId(
      state.getActiveViewId(),
      'Active view id'
    );
    liveViewHidden = requireBoolean(
      viewer.getLiveViewHidden(),
      'Viewer live-view visibility'
    );
    syncActiveViewSelectOptions();
    renderSplitViewBadges();
    updateSplitViewUI();
  }

  return {
    renderSplitViewBadges,
    updateSplitViewUI,
    refreshUIForActiveView: () => callbacks.onActiveViewChanged(activeViewId),
    syncFromStateAndViewer,
    getActiveViewId: () => activeViewId,
    getLayoutMode: () => viewLayoutMode,
  };
}
