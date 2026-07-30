/**
 * @fileoverview Dimension (embedding) selector controls.
 *
 * Controls the active view's embedding dimension (1D/2D/3D).
 * Delegates actual data switching to `DataState.setDimensionLevel`.
 *
 * @module ui/modules/dimension-controls
 */

import { getNotificationCenter } from '../../notification-center.js';

const SUPPORTED_DIMENSIONS = new Set([1, 2, 3]);

/**
 * @param {object} options
 * @param {object} options.state
 * @param {object} options.dom
 * @param {{ onViewBadgesMaybeChanged: () => void }} options.callbacks
 */
export function initDimensionControls({ state, dom, callbacks }) {
  for (const methodName of [
    'getActiveViewId',
    'getAvailableDimensions',
    'getViewDimensionLevel',
    'on',
    'setDimensionLevel',
  ]) {
    if (
      state === null ||
      typeof state !== 'object' ||
      typeof state[methodName] !== 'function'
    ) {
      throw new TypeError(
        `Dimension controls require state.${methodName}().`
      );
    }
  }
  if (
    dom === null ||
    typeof dom !== 'object' ||
    !(dom.controls instanceof HTMLElement) ||
    !(dom.select instanceof HTMLSelectElement) ||
    dom.controls.ownerDocument !== dom.select.ownerDocument
  ) {
    throw new TypeError(
      'Dimension controls require one controls element and one select from the same document.'
    );
  }
  if (
    callbacks === null ||
    typeof callbacks !== 'object' ||
    typeof callbacks.onViewBadgesMaybeChanged !== 'function'
  ) {
    throw new TypeError(
      'Dimension controls require onViewBadgesMaybeChanged().'
    );
  }
  const dimensionControls = dom.controls;
  const dimensionSelect = dom.select;
  const ownerDocument = dimensionSelect.ownerDocument;
  const lifecycleController = new AbortController();

  let destroyed = false;
  let dimensionChangeBusy = false;
  let operationGeneration = 0;
  let activeNotification = null;
  let destructionPromise = null;
  const activeOperations = new Set();

  function assertAlive() {
    if (destroyed) {
      throw new Error('Dimension controls are unavailable after destroy().');
    }
  }

  function ownsOperation(generation) {
    return !destroyed && generation === operationGeneration;
  }

  function trackOperation(operation) {
    const tracked = Promise.resolve(operation);
    activeOperations.add(tracked);
    const retire = () => {
      activeOperations.delete(tracked);
    };
    tracked.then(retire, retire);
    return tracked;
  }

  function updateDimensionSelectValue(activeDim) {
    assertAlive();
    if (!SUPPORTED_DIMENSIONS.has(activeDim)) {
      throw new RangeError(
        'Dimension selector value must be exactly 1, 2, or 3.'
      );
    }
    dimensionSelect.value = String(activeDim);
  }

  function updateDimensionSelectUI() {
    assertAlive();
    const availableDimensions = state.getAvailableDimensions();
    if (
      !Array.isArray(availableDimensions) ||
      availableDimensions.some(
        dimension => !SUPPORTED_DIMENSIONS.has(dimension)
      ) ||
      new Set(availableDimensions).size !== availableDimensions.length
    ) {
      throw new TypeError(
        'Available dimensions must be unique integers 1, 2, or 3.'
      );
    }
    const hasMultipleDimensions = availableDimensions.length > 1;
    dimensionControls.style.display = hasMultipleDimensions ? 'block' : 'none';

    const activeView = state.getActiveViewId();
    if (typeof activeView !== 'string' || activeView.length === 0) {
      throw new TypeError(
        'Dimension controls require one exact active view id.'
      );
    }
    const currentDim = state.getViewDimensionLevel(activeView);
    if (
      availableDimensions.length > 0 &&
      !availableDimensions.includes(currentDim)
    ) {
      throw new RangeError(
        `View "${activeView}" uses an unavailable dimension.`
      );
    }

    dimensionSelect.innerHTML = '';

    const sortedDims = [...availableDimensions].sort(
      (left, right) => left - right
    );
    for (const dim of sortedDims) {
      const option = ownerDocument.createElement('option');
      option.value = String(dim);
      option.textContent = `${dim}D`;
      dimensionSelect.appendChild(option);
    }

    dimensionSelect.value = String(currentDim);
  }

  async function runDimensionChange(newLevel, targetViewId = null, options = {}) {
    assertAlive();
    if (!SUPPORTED_DIMENSIONS.has(newLevel)) {
      throw new RangeError(
        `Dimension must be exactly 1, 2, or 3; received ${String(newLevel)}.`
      );
    }
    if (dimensionChangeBusy) {
      throw new Error('A dimension change is already in progress.');
    }

    const availableDimensions = state.getAvailableDimensions();
    if (!availableDimensions.includes(newLevel)) {
      throw new RangeError(`Dimension ${newLevel}D is not available in this dataset.`);
    }

    if (
      options === null ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).some(key => key !== 'silent') ||
      (
        Object.hasOwn(options, 'silent') &&
        typeof options.silent !== 'boolean'
      )
    ) {
      throw new TypeError(
        'Dimension UI options may contain only boolean "silent".'
      );
    }
    const silent = options.silent === true;
    const viewId = targetViewId === null
      ? state.getActiveViewId()
      : targetViewId;
    if (typeof viewId !== 'string' || viewId.length === 0) {
      throw new TypeError('Dimension change view id must be a non-empty string.');
    }
    const currentDim = state.getViewDimensionLevel(viewId);
    if (newLevel === currentDim) return;

    dimensionChangeBusy = true;
    const generation = ++operationGeneration;
    const notifications = silent ? null : getNotificationCenter();
    const dimNotifId = notifications === null
      ? null
      : notifications.loading(
          `Switching to ${newLevel}D embedding...`,
          { category: 'dimension' }
        );
    activeNotification = notifications === null
      ? null
      : Object.freeze({ generation, id: dimNotifId, notifications });

    updateDimensionSelectValue(newLevel);

    try {
      await state.setDimensionLevel(newLevel, { viewId });
      if (!ownsOperation(generation)) return;
      callbacks.onViewBadgesMaybeChanged();
      if (notifications !== null) {
        notifications.complete(
          dimNotifId,
          `Switched to ${newLevel}D embedding`
        );
      }
    } catch (err) {
      if (!ownsOperation(generation)) return;
      updateDimensionSelectValue(currentDim);
      if (notifications !== null) {
        const message = err instanceof Error
          ? err.message
          : 'Dimension change rejected with a non-Error value.';
        notifications.fail(dimNotifId, message);
      }
      throw err;
    } finally {
      if (generation === operationGeneration) {
        dimensionChangeBusy = false;
        activeNotification = null;
      }
    }
  }

  function handleDimensionChange(
    newLevel,
    targetViewId = null,
    options = {}
  ) {
    return trackOperation(
      runDimensionChange(newLevel, targetViewId, options)
    );
  }

  function handleDimensionSelectEvent(event) {
    if (destroyed) return;
    const rawDimension = event.target.value;
    if (!['1', '2', '3'].includes(rawDimension)) {
      throw new RangeError(
        `Dimension selector requires exactly "1", "2", or "3"; received ${String(rawDimension)}.`
      );
    }
    void handleDimensionChange(
      Number(rawDimension),
      state.getActiveViewId(),
      { silent: false }
    ).catch(error => {
      if (destroyed) return;
      // Direct callers receive the rejection from handleDimensionChange().
      // DOM event dispatch has no promise consumer, so the notification is the
      // terminal publication and the rejection must remain observed here.
      console.error('[DimensionControls] Dimension change failed:', error);
    });
  }

  dimensionSelect.addEventListener('change', handleDimensionSelectEvent, {
    signal: lifecycleController.signal
  });

  const unsubscribeDimensionChanged = state.on('dimension:changed', (level) => {
    if (destroyed) return;
    if (!dimensionChangeBusy) {
      updateDimensionSelectValue(level);
    }
  });
  if (typeof unsubscribeDimensionChanged !== 'function') {
    lifecycleController.abort();
    throw new TypeError(
      'Dimension controls require state.on() to return an unsubscribe function.'
    );
  }

  updateDimensionSelectUI();

  function destroy() {
    if (destructionPromise !== null) return destructionPromise;
    let resolveDestruction;
    let rejectDestruction;
    destructionPromise = new Promise((resolve, reject) => {
      resolveDestruction = resolve;
      rejectDestruction = reject;
    });
    destroyed = true;
    operationGeneration =
      operationGeneration === Number.MAX_SAFE_INTEGER
        ? 1
        : operationGeneration + 1;
    dimensionChangeBusy = false;
    const cleanupErrors = [];
    try {
      lifecycleController.abort();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      unsubscribeDimensionChanged();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (activeNotification !== null) {
      try {
        activeNotification.notifications.dismiss(activeNotification.id);
      } catch (error) {
        cleanupErrors.push(error);
      }
      activeNotification = null;
    }
    void Promise.allSettled([...activeOperations])
      .then(() => {
        if (cleanupErrors.length === 1) throw cleanupErrors[0];
        if (cleanupErrors.length > 1) {
          throw new AggregateError(
            cleanupErrors,
            'Dimension controls could not release every owner.'
          );
        }
      })
      .then(resolveDestruction, rejectDestruction);
    return destructionPromise;
  }

  return {
    destroy,
    updateDimensionSelectUI,
    handleDimensionChange
  };
}
