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
import {
  clearPublishedSnapshotViews,
  publishSnapshotView,
  retireSnapshotView,
} from '../../view-snapshot-publication.js';

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
    'createViewFromSource',
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

  /**
   * The three pieces of view state this module draws are read from their
   * owners on every use. None of them is mirrored here.
   *
   * Each owner reconciles itself, and none of them can announce it. The
   * DataState returns the active view to the live view whenever a view context
   * is retired (`view-context-core.js` `removeView` / `syncSnapshotContexts`);
   * the viewer returns focus to the live view and un-hides it whenever its
   * snapshot inventory empties (`viewer.js` `removeSnapshotView` /
   * `clearSnapshotViews`); the layout selector is the control the user turns.
   * A session restore empties the inventory as its first act
   * (`state-serializer/multiview.js`), so a private copy of any of the three
   * was stale from the next line onwards, and the badge render that the same
   * rebuild scheduled threw on a view that no longer existed (CEL-0239).
   */
  function currentActiveViewId() {
    return requireViewId(state.getActiveViewId(), 'Active view id');
  }
  function currentLayoutMode() {
    return requireLayoutMode(viewLayoutModeSelect.value);
  }
  function isLiveViewHidden() {
    return requireBoolean(
      viewer.getLiveViewHidden(),
      'Viewer live-view visibility'
    );
  }
  let destroyed = false;
  let lifecycleGeneration = 0;
  let destructionPromise = null;
  const pendingDimensionBadgeTasks = new Set();

  function reportUiFailure(action, error) {
    getNotificationCenter().error(
      `${action}: ${describeError(error)}`,
      { category: 'render', duration: 10000 }
    );
  }

  function runUiAction(action, operation) {
    if (destroyed) return false;
    try {
      return operation();
    } catch (error) {
      let reportedError = error;
      try {
        syncFromStateAndViewer(true);
      } catch (reconciliationError) {
        reportedError = new AggregateError(
          [error, reconciliationError],
          `${action} failed and the view UI could not be reconciled.`
        );
      }
      reportUiFailure(action, reportedError);
      return false;
    }
  }

  function requireCurrentInventory() {
    const snapshots = requireSnapshotInventory(viewer);
    const activeViewId = currentActiveViewId();
    const validIds = new Set([
      LIVE_VIEW_ID,
      ...snapshots.map(snapshot => snapshot.id),
    ]);
    if (!validIds.has(activeViewId)) {
      throw new RangeError(
        `Active view "${activeViewId}" is not in the viewer inventory.`
      );
    }
    if (isLiveViewHidden() && activeViewId === LIVE_VIEW_ID) {
      throw new RangeError('A hidden live view cannot be the active view.');
    }
    return snapshots;
  }

  function pushViewLayoutToViewer() {
    const layoutMode = currentLayoutMode();
    requireCurrentInventory();
    viewer.setViewLayout(layoutMode, currentActiveViewId());
  }

  function syncActiveViewSelectOptions() {
    requireCurrentInventory();
  }

  /**
   * Publish one active view to the owner, then draw from the owner.
   *
   * Callers used to assign a private mirror and let this push it. Passing the
   * id is what keeps the owner the only copy: the value this notifies with is
   * the value the DataState accepted.
   *
   * @param {string} viewId
   * @param {boolean} [notifyActiveView]
   */
  function activateView(viewId, notifyActiveView = true) {
    const exactViewId = requireViewId(viewId, 'Activated view id');
    if (typeof notifyActiveView !== 'boolean') {
      throw new TypeError(
        'Active-view UI notification ownership must be one exact boolean.'
      );
    }
    const publishedViewId = state.setActiveView(exactViewId);
    if (publishedViewId !== exactViewId) {
      throw new Error(
        `State published active view "${String(publishedViewId)}" instead of "${exactViewId}".`
      );
    }
    if (notifyActiveView) {
      callbacks.onActiveViewChanged(exactViewId);
    }
  }

  function snapshotIds(snapshots = requireSnapshotInventory(viewer)) {
    return snapshots.map(snapshot => snapshot.id);
  }

  function syncSnapshotContexts() {
    state.syncSnapshotContexts(snapshotIds());
  }

  function removeSnapshot(snapshotId) {
    let after;
    try {
      after = retireSnapshotView({
        state,
        viewer,
        snapshotId,
      });
    } catch (error) {
      try {
        syncFromStateAndViewer();
      } catch (reconciliationError) {
        throw new AggregateError(
          [error, reconciliationError],
          `Snapshot "${snapshotId}" removal failed and its UI could not be reconciled.`
        );
      }
      throw error;
    }
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
      if (destroyed) return;
      const ownerGeneration = lifecycleGeneration;
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
        if (
          destroyed ||
          ownerGeneration !== lifecycleGeneration
        ) {
          return;
        }
        dimIndicator.removeAttribute('aria-invalid');
        renderSplitViewBadges();
      } catch (error) {
        if (
          destroyed ||
          ownerGeneration !== lifecycleGeneration
        ) {
          return;
        }
        dimIndicator.setAttribute('aria-invalid', 'true');
        dimIndicator.title =
          `Dimension change failed: ${describeError(error)}`;
      } finally {
        dimensionBadgeBusy = false;
        if (
          !destroyed &&
          ownerGeneration === lifecycleGeneration
        ) {
          dimIndicator.removeAttribute('aria-disabled');
        }
      }
    };
    const startDimensionCycle = event => {
      if (destroyed) return;
      let task;
      task = cycleDimension(event)
        .catch(error => {
          if (!destroyed) {
            reportUiFailure('Dimension change failed', error);
          }
        })
        .finally(() => {
          pendingDimensionBadgeTasks.delete(task);
        });
      pendingDimensionBadgeTasks.add(task);
    };
    dimIndicator.addEventListener('click', event => {
      startDimensionCycle(event);
    });
    dimIndicator.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        startDimensionCycle(event);
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
    if (destroyed) return false;
    splitViewBadges.innerHTML = '';
    const snapshots = requireCurrentInventory();
    // One read of each owner for one render pass. Every handler attached below
    // reads its own, because it runs long after this pass finished.
    const activeViewId = currentActiveViewId();
    const liveViewHidden = isLiveViewHidden();

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
          activateView(LIVE_VIEW_ID);
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
              activateView(LIVE_VIEW_ID);
              pushViewLayoutToViewer();
            } else {
              if (currentActiveViewId() === LIVE_VIEW_ID) {
                activateView(currentSnapshots[0].id);
                pushViewLayoutToViewer();
              }
              viewer.setLiveViewHidden(true);
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
          activateView(snapId);
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
            const removedActiveView = snapId === currentActiveViewId();
            const remainingSnaps = removeSnapshot(snapId);
            const remainingActiveViewId = currentActiveViewId();
            const activeStillExists =
              remainingActiveViewId === LIVE_VIEW_ID ||
              remainingSnaps.some(
                snapshot => snapshot.id === remainingActiveViewId
              );
            if (removedActiveView || !activeStillExists) {
              if (isLiveViewHidden()) {
                if (remainingSnaps.length === 0) {
                  throw new Error(
                    'Viewer kept the live view hidden without any snapshot.'
                  );
                }
                activateView(remainingSnaps[0].id);
              } else {
                activateView(LIVE_VIEW_ID);
              }
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

  function syncRenderModeState(mode, publishLayout) {
    const exactMode = requireRenderMode(mode);
    if (typeof publishLayout !== 'boolean') {
      throw new TypeError(
        'Render-mode layout publication must be one exact boolean.'
      );
    }
    if (renderModeSelect.value !== exactMode) {
      throw new Error(
        `Render-mode controls cannot publish "${exactMode}" while the selector owns ` +
        `"${renderModeSelect.value}".`
      );
    }
    const modeIsPoints = exactMode === 'points';
    if (!modeIsPoints) {
      if (publishLayout) {
        if (isLiveViewHidden() || currentActiveViewId() !== LIVE_VIEW_ID) {
          throw new Error(
            'Smoke render mode requires the visible live view to own focus.'
          );
        }
        viewer.setViewLayout('single', LIVE_VIEW_ID);
      }
      viewLayoutModeSelect.value = 'single';
    }
    splitKeepViewBtn.disabled = !modeIsPoints;
    splitKeepViewBtn.title = modeIsPoints
      ? 'Freeze the current view as a panel'
      : 'Switch to “Points” mode to keep views';
    viewLayoutModeSelect.disabled = !modeIsPoints;
  }

  function syncRenderModeUI(mode) {
    if (destroyed) return false;
    syncRenderModeState(mode, true);
  }

  function reconcileSplitViewUI(notifyActiveView) {
    if (typeof notifyActiveView !== 'boolean') {
      throw new TypeError(
        'Split-view reconciliation notification ownership must be one exact boolean.'
      );
    }
    const renderMode = requireRenderMode(renderModeSelect.value);
    const modeIsPoints = renderMode === 'points';
    const snapshots = requireCurrentInventory();
    state.syncSnapshotContexts(snapshotIds(snapshots));

    const hasSnaps = snapshots.length > 0;
    const hasMultipleViews = snapshots.length > 0;
    splitViewBadgesBox.style.display = hasMultipleViews ? '' : 'none';
    syncActiveViewSelectOptions();

    syncRenderModeState(renderMode, false);
    splitClearBtn.disabled = !hasSnaps;
    cameraLockBtn.disabled = !hasMultipleViews;
    // Keep the button label/aria state in sync in case camera lock is toggled
    // programmatically (e.g., session restore).
    updateCameraLockUI();
    if (!hasMultipleViews) {
      cameraLockBtn.title = 'Add a kept view to link cameras';
    }

    if (!modeIsPoints) {
      viewLayoutModeSelect.value = 'single';
      if (isLiveViewHidden()) {
        viewer.setLiveViewHidden(false);
      }
    }

    // An unusable layout selection is refused before anything is published,
    // which is where the copy this used to keep was validated.
    currentLayoutMode();
    activateView(
      modeIsPoints ? currentActiveViewId() : LIVE_VIEW_ID,
      notifyActiveView
    );
    pushViewLayoutToViewer();
  }

  function updateSplitViewUI() {
    if (destroyed) return false;
    reconcileSplitViewUI(true);
  }

  function handleKeepView() {
    if (requireRenderMode(renderModeSelect.value) !== 'points') {
      throw new Error('Kept views are available only in Points render mode.');
    }
    const sourceViewId = currentActiveViewId();
    const sourceLayoutMode = currentLayoutMode();
    const payload = requireSnapshotPayload(state.getSnapshotPayload());
    let createdId = null;
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

      const created = publishSnapshotView({
        state,
        viewer,
        config: snapshotConfig,
      });
      createdId = requireViewId(created.id, 'Created snapshot id');
      viewLayoutModeSelect.value = 'grid';

      activateView(createdId);
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
        rollback(() => retireSnapshotView({
          state,
          viewer,
          snapshotId: createdId,
        }));
      }
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
      rollback(() => syncFromStateAndViewer(true));
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
    try {
      clearPublishedSnapshotViews({ state, viewer });
    } catch (error) {
      try {
        syncFromStateAndViewer();
      } catch (reconciliationError) {
        throw new AggregateError(
          [error, reconciliationError],
          'Snapshot clearing failed and its UI could not be reconciled.'
        );
      }
      throw error;
    }
    // `clearPublishedSnapshotViews()` already returned the DataState's active
    // view to the live view and the viewer's live view to visible; this only
    // has to publish the layout the cleared interface uses.
    viewLayoutModeSelect.value = 'grid';
    activateView(LIVE_VIEW_ID);
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
    if (isLiveViewHidden() && newViewId === LIVE_VIEW_ID) {
      throw new RangeError('A hidden live view cannot receive focus.');
    }
    const viewChanged = currentActiveViewId() !== newViewId;

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

  const handleViewFocus = viewId => {
    runUiAction(
      'View focus failed',
      () => focusViewFromOverlay(viewId)
    );
  };
  viewer.setViewFocusHandler(handleViewFocus);

  const handleKeepViewClick = () => {
    runUiAction('Keep view failed', handleKeepView);
  };
  const handleClearViewsClick = () => {
    runUiAction('Clear views failed', handleClearViews);
  };
  const handleCameraLockClick = () => {
    runUiAction('Camera lock change failed', () => {
      const newLocked = !requireBoolean(
        viewer.getCamerasLocked(),
        'Viewer camera lock'
      );
      viewer.setCamerasLocked(newLocked);
      updateCameraLockUI();
      renderSplitViewBadges();
      callbacks.onNavigationUiSyncRequested(currentActiveViewId());
    });
  };
  splitKeepViewBtn.addEventListener('click', handleKeepViewClick);
  splitClearBtn.addEventListener('click', handleClearViewsClick);
  cameraLockBtn.addEventListener('click', handleCameraLockClick);
  updateCameraLockUI();
  const handleLayoutModeChange = () => {
    runUiAction('View layout change failed', () => {
      pushViewLayoutToViewer();
      renderSplitViewBadges();
      updateSplitViewUI();
    });
  };
  viewLayoutModeSelect.addEventListener(
    'change',
    handleLayoutModeChange
  );

  renderSplitViewBadges();
  updateSplitViewUI();

  function syncFromStateAndViewer(forceActiveViewNotification = false) {
    if (destroyed) {
      throw new Error('View controls are unavailable after destroy().');
    }
    if (typeof forceActiveViewNotification !== 'boolean') {
      throw new TypeError(
        'View reconciliation notification ownership must be one exact boolean.'
      );
    }
    const previousActiveViewId = currentActiveViewId();
    const snapshots = requireSnapshotInventory(viewer);
    const snapshotIdSet = new Set(
      snapshots.map(snapshot => snapshot.id)
    );
    const liveViewHidden = isLiveViewHidden();
    const activeViewExists =
      previousActiveViewId === LIVE_VIEW_ID ||
      snapshotIdSet.has(previousActiveViewId);
    if (
      !activeViewExists ||
      (liveViewHidden && previousActiveViewId === LIVE_VIEW_ID)
    ) {
      const nextActiveViewId =
        liveViewHidden && snapshots.length > 0
          ? snapshots[0].id
          : LIVE_VIEW_ID;
      const publishedViewId = state.setActiveView(nextActiveViewId);
      if (publishedViewId !== nextActiveViewId) {
        throw new Error(
          `State did not reconcile active view "${nextActiveViewId}".`
        );
      }
    }
    reconcileSplitViewUI(false);
    // Reconciliation publishes the corrected focus/layout first so badges
    // cannot retain a camera marker for a snapshot that was just retired.
    renderSplitViewBadges();
    const activeViewId = currentActiveViewId();
    if (
      forceActiveViewNotification ||
      activeViewId !== previousActiveViewId
    ) {
      callbacks.onActiveViewChanged(activeViewId);
    }
  }

  return {
    renderSplitViewBadges,
    syncRenderModeUI,
    updateSplitViewUI,
    syncFromStateAndViewer,
    destroy() {
      if (destructionPromise !== null) return destructionPromise;
      destroyed = true;
      lifecycleGeneration += 1;
      const failures = [];
      const cleanup = operation => {
        try {
          operation();
        } catch (error) {
          failures.push(error);
        }
      };
      cleanup(() => {
        splitKeepViewBtn.removeEventListener('click', handleKeepViewClick);
      });
      cleanup(() => {
        splitClearBtn.removeEventListener('click', handleClearViewsClick);
      });
      cleanup(() => {
        cameraLockBtn.removeEventListener('click', handleCameraLockClick);
      });
      cleanup(() => {
        viewLayoutModeSelect.removeEventListener(
          'change',
          handleLayoutModeChange
        );
      });
      cleanup(() => splitViewBadges.replaceChildren());
      cleanup(() => viewer.setViewFocusHandler(() => {}));
      destructionPromise = Promise
        .allSettled([...pendingDimensionBadgeTasks])
        .then(outcomes => {
          for (const outcome of outcomes) {
            if (outcome.status === 'rejected') {
              failures.push(outcome.reason);
            }
          }
          const exactFailures = [...new Set(failures)];
          if (exactFailures.length === 1) throw exactFailures[0];
          if (exactFailures.length > 1) {
            throw new AggregateError(
              exactFailures,
              'View-control teardown was incomplete.'
            );
          }
        });
      return destructionPromise;
    },
  };
}
