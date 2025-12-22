/**
 * @fileoverview Dimension (embedding) selector controls.
 *
 * Controls the active view's embedding dimension (1D/2D/3D/4D*).
 * Delegates actual data switching to `DataState.setDimensionLevel`.
 *
 * @module ui/modules/dimension-controls
 */

import { getNotificationCenter } from '../../notification-center.js';

const LIVE_VIEW_ID = 'live';

export function initDimensionControls({ state, viewer, dom, callbacks = {} }) {
  const dimensionControls = dom?.controls || null;
  const dimensionSelect = dom?.select || null;

  let dimensionChangeBusy = false;

  function updateDimensionSelectValue(activeDim) {
    if (!dimensionSelect) return;
    dimensionSelect.value = String(activeDim);
  }

  function updateDimensionSelectUI() {
    if (!dimensionControls || !dimensionSelect) return;

    const availableDimensions = state.getAvailableDimensions?.() || [3];
    const hasMultipleDimensions = availableDimensions.length > 1;
    dimensionControls.style.display = hasMultipleDimensions ? 'block' : 'none';
    if (!hasMultipleDimensions) return;

    const activeView = typeof state.getActiveViewId === 'function'
      ? state.getActiveViewId()
      : (typeof viewer.getFocusedViewId === 'function' ? viewer.getFocusedViewId() : LIVE_VIEW_ID);
    const currentDim = state.getViewDimensionLevel?.(activeView) ?? state.getDimensionLevel?.() ?? 3;

    dimensionSelect.innerHTML = '';

    const sortedDims = [1, 2, 3, 4].filter((d) => availableDimensions.includes(d));
    for (const dim of sortedDims) {
      const option = document.createElement('option');
      option.value = String(dim);
      option.textContent = `${dim}D`;
      if (dim === 4) {
        option.disabled = true;
        option.title = '4D embedding: reserved for future versions';
      }
      dimensionSelect.appendChild(option);
    }

    dimensionSelect.value = String(currentDim);
  }

  async function handleDimensionChange(newLevel, targetViewId = null, options = {}) {
    if (dimensionChangeBusy) return;
    if (!state.setDimensionLevel) return;

    const availableDimensions = state.getAvailableDimensions?.() || [3];
    if (!availableDimensions.includes(newLevel)) return;

    const silent = options?.silent === true;

    const viewerFocusedView = typeof viewer.getFocusedViewId === 'function' ? viewer.getFocusedViewId() : null;
    const viewId = targetViewId ?? viewerFocusedView ?? (state.getActiveViewId?.() || LIVE_VIEW_ID);

    const currentDim = state.getViewDimensionLevel?.(viewId) ?? state.getDimensionLevel?.() ?? 3;
    if (newLevel === currentDim) return;

    dimensionChangeBusy = true;
    const notifications = silent ? null : getNotificationCenter();
    const dimNotifId = notifications?.loading?.(`Switching to ${newLevel}D embedding...`, { category: 'dimension' });

    updateDimensionSelectValue(newLevel);

    try {
      await state.setDimensionLevel(newLevel, { viewId });
      callbacks.onViewBadgesMaybeChanged?.();
      notifications?.complete?.(dimNotifId, `Switched to ${newLevel}D embedding`);
    } catch (err) {
      console.error('[UI] Failed to change dimension:', err);
      updateDimensionSelectValue(currentDim);
      notifications?.fail?.(dimNotifId, err?.message || 'Failed to change dimension');
    } finally {
      dimensionChangeBusy = false;
    }
  }

  if (dimensionSelect) {
    dimensionSelect.addEventListener('change', (e) => {
      const newDim = parseInt(e.target.value, 10);
      if (!Number.isNaN(newDim)) {
        handleDimensionChange(newDim);
      }
    });
  }

  state.on('dimension:changed', (level) => {
    if (!dimensionChangeBusy) {
      updateDimensionSelectValue(level);
    }
  });

  updateDimensionSelectUI();

  return { updateDimensionSelectUI, handleDimensionChange };
}
