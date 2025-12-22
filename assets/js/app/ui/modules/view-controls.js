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

const LIVE_VIEW_ID = 'live';

/**
 * @typedef {object} ViewCallbacks
 * @property {(viewId: string) => void} [onActiveViewChanged]
 * @property {(viewId: string, nextDim: number) => Promise<void>} [onCycleViewDimension]
 * @property {(viewId: string) => void} [onNavigationUiSyncRequested]
 */

export function initViewControls({ state, viewer, dom, renderDom, callbacks = /** @type {ViewCallbacks} */ ({}) }) {
  const splitViewControls = dom?.controls || null;
  const splitKeepViewBtn = dom?.keepViewBtn || null;
  const splitClearBtn = dom?.clearBtn || null;
  const cameraLockBtn = dom?.cameraLockBtn || null;
  const viewLayoutModeSelect = dom?.layoutModeSelect || null;
  const splitViewBadgesBox = dom?.badgesBox || null;
  const splitViewBadges = dom?.badgesList || null;
  const splitViewBoxTitle = dom?.boxTitle || null;

  const renderModeSelect = renderDom?.renderModeSelect || null;

  let activeViewId = typeof state.getActiveViewId === 'function'
    ? String(state.getActiveViewId() || LIVE_VIEW_ID)
    : LIVE_VIEW_ID;
  let viewLayoutMode = 'grid'; // 'grid' or 'single'
  let liveViewHidden = typeof viewer.getLiveViewHidden === 'function'
    ? viewer.getLiveViewHidden()
    : false;

  function pushViewLayoutToViewer() {
    if (typeof viewer.setViewLayout !== 'function') return;
    viewer.setViewLayout(viewLayoutMode, activeViewId);
  }

  function syncActiveViewSelectOptions() {
    const snapshots = typeof viewer.getSnapshotViews === 'function'
      ? viewer.getSnapshotViews()
      : [];
    const validIds = new Set([LIVE_VIEW_ID, ...snapshots.map(s => String(s.id))]);
    if (!validIds.has(String(activeViewId))) {
      activeViewId = LIVE_VIEW_ID;
    }
  }

  function syncActiveViewToState() {
    if (typeof state.setActiveView === 'function') {
      state.setActiveView(activeViewId);
    }
    callbacks.onActiveViewChanged?.(String(activeViewId));
  }

  let dimensionBadgeBusy = false;
  function createDimensionIndicator(viewId, currentDim) {
    const availableDims = state.getAvailableDimensions?.() || [3];
    const usableDims = availableDims.filter(d => d !== 4);
    if (usableDims.length <= 1) return null;

    const dimIndicator = document.createElement('span');
    dimIndicator.className = 'split-badge-dim';
    dimIndicator.textContent = `${currentDim}D`;
    dimIndicator.title = 'Click to cycle dimension (1D/2D/3D)';
    dimIndicator.dataset.viewId = String(viewId);

    dimIndicator.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (dimensionBadgeBusy) return;

      const targetViewId = String(e.currentTarget.dataset.viewId || LIVE_VIEW_ID);
      const freshCurrentDim = state.getViewDimensionLevel?.(targetViewId) ?? state.getDimensionLevel?.() ?? 3;
      const sortedDims = [...usableDims].sort((a, b) => b - a);
      const currentIdx = sortedDims.indexOf(freshCurrentDim);
      const nextIdx = (currentIdx + 1) % sortedDims.length;
      const nextDim = sortedDims[nextIdx];

      if (!callbacks.onCycleViewDimension) return;

      dimensionBadgeBusy = true;
      try {
        await callbacks.onCycleViewDimension(targetViewId, nextDim);
        renderSplitViewBadges();
      } catch (err) {
        console.error('[UI] Failed to change dimension:', err);
      } finally {
        dimensionBadgeBusy = false;
      }
    });

    return dimIndicator;
  }

  const NAV_MODE_LABELS = { orbit: 'Orb', planar: 'Pan', free: 'Fly' };
  const NAV_MODE_CYCLE = ['orbit', 'planar', 'free'];

  function createNavigationIndicator(viewId, currentMode) {
    const camerasLocked = typeof viewer.getCamerasLocked === 'function' ? viewer.getCamerasLocked() : true;
    if (camerasLocked) return null;

    const navIndicator = document.createElement('span');
    navIndicator.className = 'split-badge-nav';
    navIndicator.textContent = NAV_MODE_LABELS[currentMode] || 'Orb';
    navIndicator.title = 'Click to cycle navigation mode (Orbit/Planar/Free-fly)';
    navIndicator.dataset.viewId = String(viewId);

    navIndicator.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const targetViewId = String(e.currentTarget.dataset.viewId || LIVE_VIEW_ID);
      const freshCurrentMode = typeof viewer.getViewNavigationMode === 'function'
        ? viewer.getViewNavigationMode(targetViewId)
        : 'orbit';

      const currentIdx = NAV_MODE_CYCLE.indexOf(freshCurrentMode);
      const nextIdx = (currentIdx + 1) % NAV_MODE_CYCLE.length;
      const nextMode = NAV_MODE_CYCLE[nextIdx];

      const focusedId = typeof viewer.getFocusedViewId === 'function' ? viewer.getFocusedViewId() : LIVE_VIEW_ID;
      const isFocusedView = targetViewId === focusedId;

      if (isFocusedView && typeof viewer.setNavigationMode === 'function') {
        viewer.setNavigationMode(nextMode);
      }
      if (typeof viewer.setViewNavigationMode === 'function') {
        viewer.setViewNavigationMode(targetViewId, nextMode);
      }

      renderSplitViewBadges();
      if (isFocusedView) {
        callbacks.onNavigationUiSyncRequested?.(targetViewId);
      }
    });

    return navIndicator;
  }

  function renderSplitViewBadges() {
    if (!splitViewBadges) return;

    splitViewBadges.innerHTML = '';

    const snapshots = typeof viewer.getSnapshotViews === 'function'
      ? viewer.getSnapshotViews()
      : [];

    if (liveViewHidden && snapshots.length <= 1) {
      liveViewHidden = false;
      if (typeof viewer.setLiveViewHidden === 'function') {
        viewer.setLiveViewHidden(false);
      }
    }

    let badgeIndex = 1;

    if (!liveViewHidden) {
      const liveLabel = typeof viewer.getLiveViewLabel === 'function'
        ? viewer.getLiveViewLabel()
        : 'All cells';

      const liveBadge = document.createElement('div');
      liveBadge.className = 'split-badge';
      if (String(activeViewId) === LIVE_VIEW_ID) {
        liveBadge.classList.add('active');
      }

      const camerasLocked = typeof viewer.getCamerasLocked === 'function' ? viewer.getCamerasLocked() : true;
      const focusedId = typeof viewer.getFocusedViewId === 'function' ? viewer.getFocusedViewId() : LIVE_VIEW_ID;
      if (!camerasLocked && focusedId === LIVE_VIEW_ID) {
        liveBadge.classList.add('active-camera');
      }

      liveBadge.addEventListener('click', () => {
        activeViewId = LIVE_VIEW_ID;
        syncActiveViewToState();
        pushViewLayoutToViewer();
        renderSplitViewBadges();
        callbacks.onNavigationUiSyncRequested?.(LIVE_VIEW_ID);
      });

      const livePill = document.createElement('span');
      livePill.className = 'split-badge-pill';
      livePill.textContent = String(badgeIndex);

      const liveCameraIndicator = document.createElement('span');
      liveCameraIndicator.className = 'split-badge-camera';
      liveCameraIndicator.textContent = '\u2316';

      const liveText = document.createElement('span');
      liveText.className = 'split-badge-label';
      liveText.textContent = liveLabel;

      const liveDim = state.getViewDimensionLevel?.(LIVE_VIEW_ID) ?? state.getDimensionLevel?.() ?? 3;
      const liveDimIndicator = createDimensionIndicator(LIVE_VIEW_ID, liveDim);

      const liveNavMode = typeof viewer.getViewNavigationMode === 'function'
        ? viewer.getViewNavigationMode(LIVE_VIEW_ID)
        : 'orbit';
      const liveNavIndicator = createNavigationIndicator(LIVE_VIEW_ID, liveNavMode);

      if (snapshots.length > 0) {
        const liveRemoveBtn = document.createElement('button');
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
          const currentSnapshots = typeof viewer.getSnapshotViews === 'function'
            ? viewer.getSnapshotViews()
            : [];
          if (currentSnapshots.length === 0) return;

          if (currentSnapshots.length === 1) {
            const snapToRemove = currentSnapshots[0];
            viewer.removeSnapshotView?.(snapToRemove.id);
            state.removeView?.(snapToRemove.id);
            state.syncSnapshotContexts?.([]);
            activeViewId = LIVE_VIEW_ID;
            syncActiveViewToState();
            pushViewLayoutToViewer();
          } else {
            liveViewHidden = true;
            viewer.setLiveViewHidden?.(true);
            if (String(activeViewId) === LIVE_VIEW_ID) {
              activeViewId = String(currentSnapshots[0].id);
              syncActiveViewToState();
              pushViewLayoutToViewer();
            }
          }
          renderSplitViewBadges();
          updateSplitViewUI();
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
      const badge = document.createElement('div');
      badge.className = 'split-badge';
      const snapId = String(snap.id);
      if (snapId === String(activeViewId)) {
        badge.classList.add('active');
      }

      const camerasLockedSnap = typeof viewer.getCamerasLocked === 'function' ? viewer.getCamerasLocked() : true;
      const focusedIdSnap = typeof viewer.getFocusedViewId === 'function' ? viewer.getFocusedViewId() : LIVE_VIEW_ID;
      if (!camerasLockedSnap && focusedIdSnap === snapId) {
        badge.classList.add('active-camera');
      }

      badge.addEventListener('click', () => {
        activeViewId = snapId;
        syncActiveViewToState();
        pushViewLayoutToViewer();
        renderSplitViewBadges();
        callbacks.onNavigationUiSyncRequested?.(snapId);
      });

      const pill = document.createElement('span');
      pill.className = 'split-badge-pill';
      pill.textContent = String(badgeIndex);

      const cameraIndicator = document.createElement('span');
      cameraIndicator.className = 'split-badge-camera';
      cameraIndicator.textContent = '\u2316';

      const text = document.createElement('span');
      text.className = 'split-badge-label';
      const mainLabel = snap.label || snap.fieldKey || `View ${badgeIndex}`;
      text.textContent = mainLabel;

      const snapDim = state.getViewDimensionLevel?.(snapId) ?? snap.dimensionLevel ?? 3;
      const snapDimIndicator = createDimensionIndicator(snapId, snapDim);

      const snapNavMode = typeof viewer.getViewNavigationMode === 'function'
        ? viewer.getViewNavigationMode(snapId)
        : (snap.cameraState?.navigationMode || 'orbit');
      const snapNavIndicator = createNavigationIndicator(snapId, snapNavMode);

      badge.appendChild(pill);
      badge.appendChild(cameraIndicator);
      badge.appendChild(text);
      if (snapDimIndicator) badge.appendChild(snapDimIndicator);
      if (snapNavIndicator) badge.appendChild(snapNavIndicator);

      if (!liveViewHidden || snapshots.length > 1) {
        const removeBtn = document.createElement('button');
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
          viewer.removeSnapshotView?.(snap.id);
          state.removeView?.(snap.id);
          if (typeof state.syncSnapshotContexts === 'function' && typeof viewer.getSnapshotViews === 'function') {
            const ids = viewer.getSnapshotViews().map((v) => v.id);
            state.syncSnapshotContexts(ids);
          }
          if (typeof viewer.getLiveViewHidden === 'function') {
            liveViewHidden = viewer.getLiveViewHidden();
          }
          const remainingSnaps = viewer.getSnapshotViews?.() || [];
          const activeExists = snapId !== String(activeViewId) &&
            (activeViewId === LIVE_VIEW_ID || remainingSnaps.some(s => String(s.id) === String(activeViewId)));
          if (snapId === String(activeViewId) || !activeExists) {
            if (!liveViewHidden) {
              activeViewId = LIVE_VIEW_ID;
            } else if (remainingSnaps.length > 0) {
              activeViewId = String(remainingSnaps[0].id);
            } else {
              liveViewHidden = false;
              viewer.setLiveViewHidden?.(false);
              activeViewId = LIVE_VIEW_ID;
            }
            syncActiveViewToState();
            pushViewLayoutToViewer();
          }
          renderSplitViewBadges();
          updateSplitViewUI();
        });
        badge.appendChild(removeBtn);
      }

      splitViewBadges.appendChild(badge);
      badgeIndex++;
    });

    syncActiveViewSelectOptions();
  }

  function updateCameraLockUI() {
    if (!cameraLockBtn || typeof viewer.getCamerasLocked !== 'function') return;
    const locked = viewer.getCamerasLocked();
    cameraLockBtn.setAttribute('aria-pressed', locked ? 'false' : 'true');
    cameraLockBtn.textContent = locked ? 'Locked Cam' : 'Unlocked Cam';
    cameraLockBtn.title = locked ? 'Cameras linked (click to unlink)' : 'Cameras independent (click to link)';
  }

  function updateSplitViewUI() {
    if (!splitViewControls) return;

    const modeIsPoints = !renderModeSelect || renderModeSelect.value === 'points';
    const snapshots = typeof viewer.getSnapshotViews === 'function'
      ? viewer.getSnapshotViews()
      : [];

    state.syncSnapshotContexts?.(snapshots.map((s) => s.id));

    const hasSnaps = snapshots.length > 0;
    const hasMultipleViews = snapshots.length > 0;
    if (splitViewBadgesBox) {
      splitViewBadgesBox.style.display = hasMultipleViews ? '' : 'none';
    }
    if (splitViewBoxTitle) {
      splitViewBoxTitle.style.display = hasMultipleViews ? '' : 'none';
    }

    syncActiveViewSelectOptions();

    if (splitKeepViewBtn) {
      splitKeepViewBtn.disabled = !modeIsPoints;
      splitKeepViewBtn.title = modeIsPoints
        ? 'Freeze the current view as a panel'
        : 'Switch to “Points” mode to keep views';
    }
    if (splitClearBtn) {
      splitClearBtn.disabled = !hasSnaps;
    }
    if (cameraLockBtn) {
      cameraLockBtn.disabled = !hasMultipleViews;
      cameraLockBtn.title = hasMultipleViews
        ? (viewer.getCamerasLocked?.()
            ? 'Cameras linked (click to unlink)'
            : 'Cameras independent (click to link)')
        : 'Add a kept view to link cameras';
    }

    if (viewLayoutModeSelect) {
      if (!modeIsPoints) {
        viewLayoutMode = 'single';
        viewLayoutModeSelect.value = 'single';
        activeViewId = LIVE_VIEW_ID;
      } else {
        viewLayoutMode = viewLayoutModeSelect.value === 'single' ? 'single' : 'grid';
      }
      viewLayoutModeSelect.disabled = !modeIsPoints;
    }

    syncActiveViewToState();
    pushViewLayoutToViewer();
  }

  function handleKeepView() {
    if (!splitKeepViewBtn) return;
    if (renderModeSelect && renderModeSelect.value !== 'points') return;
    if (!state.getSnapshotPayload || !viewer.createSnapshotView) return;

    try {
      const payload = state.getSnapshotPayload();
      if (!payload || !payload.colors || !payload.transparency) return;

      const snapshotConfig = {
        label: payload.label,
        fieldKey: payload.fieldKey,
        fieldKind: payload.fieldKind,
        colors: payload.colors,
        transparency: payload.transparency,
        outlierQuantiles: payload.outlierQuantiles,
        centroidPositions: payload.centroidPositions,
        centroidColors: payload.centroidColors,
        centroidOutliers: payload.centroidOutliers,
        centroidTransparencies: payload.centroidTransparencies,
        outlierThreshold: payload.outlierThreshold,
        dimensionLevel: payload.dimensionLevel,
        sourceViewId: activeViewId || LIVE_VIEW_ID,
        meta: { filtersText: payload.filtersText || [] }
      };

      const created = viewer.createSnapshotView(snapshotConfig);
      if (!created) return;
      state.createViewFromActive?.(created.id);

      const dimManager = state.getDimensionManager?.();
      if (dimManager && created.id) {
        dimManager.copyViewDimension(activeViewId || LIVE_VIEW_ID, created.id);
      }
      if (typeof state.syncSnapshotContexts === 'function' && typeof viewer.getSnapshotViews === 'function') {
        const ids = viewer.getSnapshotViews().map((v) => v.id);
        state.syncSnapshotContexts(ids);
      }
      if (created.id) {
        activeViewId = String(created.id);
      }

      viewLayoutMode = 'grid';
      if (viewLayoutModeSelect) viewLayoutModeSelect.value = 'grid';

      syncActiveViewToState();
      renderSplitViewBadges();
      updateSplitViewUI();
      pushViewLayoutToViewer();
    } catch (err) {
      console.error('Failed to keep view:', err);
    }
  }

  function handleClearViews() {
    if (!viewer.clearSnapshotViews) return;
    activeViewId = LIVE_VIEW_ID;
    liveViewHidden = false;
    viewLayoutMode = 'grid';
    if (viewLayoutModeSelect) viewLayoutModeSelect.value = 'grid';
    viewer.clearSnapshotViews();
    state.clearSnapshotViews?.();
    syncActiveViewToState();
    renderSplitViewBadges();
    updateSplitViewUI();
  }

  function focusViewFromOverlay(viewId) {
    if (!viewId) return;
    const newViewId = String(viewId);
    const viewChanged = activeViewId !== newViewId;
    activeViewId = newViewId;

    if (viewChanged && typeof state.setActiveView === 'function') {
      state.setActiveView(newViewId);
    }

    syncActiveViewSelectOptions();
    renderSplitViewBadges();
    updateSplitViewUI();

    if (viewChanged) {
      callbacks.onActiveViewChanged?.(newViewId);
      callbacks.onNavigationUiSyncRequested?.(newViewId);
    }
  }

  if (typeof viewer.setViewFocusHandler === 'function') {
    viewer.setViewFocusHandler((viewId) => focusViewFromOverlay(viewId));
  }

  if (splitKeepViewBtn) {
    splitKeepViewBtn.addEventListener('click', handleKeepView);
  }
  if (splitClearBtn) {
    splitClearBtn.addEventListener('click', handleClearViews);
  }
  if (cameraLockBtn && typeof viewer.getCamerasLocked === 'function') {
    cameraLockBtn.addEventListener('click', () => {
      const newLocked = !viewer.getCamerasLocked();
      viewer.setCamerasLocked?.(newLocked);
      updateCameraLockUI();
      renderSplitViewBadges();
      callbacks.onNavigationUiSyncRequested?.(String(activeViewId));
    });
    updateCameraLockUI();
  }
  if (viewLayoutModeSelect) {
    viewLayoutModeSelect.addEventListener('change', () => {
      viewLayoutMode = viewLayoutModeSelect.value === 'single' ? 'single' : 'grid';
      pushViewLayoutToViewer();
      renderSplitViewBadges();
      updateSplitViewUI();
    });
  }

  renderSplitViewBadges();
  updateSplitViewUI();

  function syncFromStateAndViewer() {
    if (typeof state.getActiveViewId === 'function') {
      const nextId = state.getActiveViewId();
      if (nextId != null) activeViewId = String(nextId);
    }
    if (typeof viewer.getLiveViewHidden === 'function') {
      liveViewHidden = viewer.getLiveViewHidden();
    }
    syncActiveViewSelectOptions();
    renderSplitViewBadges();
    updateSplitViewUI();
  }

  return {
    renderSplitViewBadges,
    updateSplitViewUI,
    refreshUIForActiveView: () => callbacks.onActiveViewChanged?.(String(activeViewId)),
    syncFromStateAndViewer,
    getActiveViewId: () => String(activeViewId),
    getLayoutMode: () => viewLayoutMode,
  };
}
