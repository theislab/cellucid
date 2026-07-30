/**
 * @fileoverview Camera + navigation controls.
 *
 * Wires the navigation mode dropdown (orbit/planar/free), look sensitivity,
 * movement speed, and related toggles (invert look, pointer lock, projectiles,
 * orbit anchor) to the Viewer API.
 *
 * @module ui/modules/camera-controls
 */

import { getNotificationCenter } from '../../notification-center.js';
import { parseRangeInput } from '../core/numeric-input-contract.js';

const REQUIRED_DOM_KEYS = [
  'navigationModeSelect',
  'freeflyControls',
  'orbitControls',
  'planarControls',
  'lookSensitivityInput',
  'lookSensitivityDisplay',
  'moveSpeedInput',
  'moveSpeedDisplay',
  'invertLookCheckbox',
  'projectilesEnabledCheckbox',
  'pointerLockCheckbox',
  'orbitKeySpeedInput',
  'orbitKeySpeedDisplay',
  'planarPanSpeedInput',
  'planarPanSpeedDisplay',
  'orbitReverseCheckbox',
  'showOrbitAnchorCheckbox',
  'planarZoomToCursorCheckbox',
  'planarInvertAxesCheckbox'
];

function assertProjectileBuildResult(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !Object.isFrozen(value) ||
    Object.keys(value).sort().join(',') !== 'message,status' ||
    !['ready', 'cancelled', 'error'].includes(value.status) ||
    (
      value.status === 'ready'
        ? value.message !== null
        : (
          typeof value.message !== 'string' ||
          value.message.length === 0 ||
          value.message.trim() !== value.message
        )
    )
  ) {
    throw new TypeError(
      'Projectile completion must be one frozen { status, message } result.'
    );
  }
  return value;
}

/**
 * @param {object} options
 * @param {object} options.viewer
 * @param {object} options.dom
 * @param {{ onViewBadgesMaybeChanged: () => void }} options.callbacks
 */
export function initCameraControls({ viewer, dom, callbacks }) {
  if (!dom || typeof dom !== 'object' || Array.isArray(dom)) {
    throw new TypeError('Compare Views camera controls require a DOM reference object.');
  }
  for (const key of REQUIRED_DOM_KEYS) {
    if (!dom[key]) {
      throw new Error(`Compare Views camera controls are missing the required "${key}" element.`);
    }
  }
  if (
    !callbacks ||
    typeof callbacks !== 'object' ||
    typeof callbacks.onViewBadgesMaybeChanged !== 'function'
  ) {
    throw new TypeError(
      'Compare Views camera controls require onViewBadgesMaybeChanged().'
    );
  }
  const notifications = getNotificationCenter();
  const lifecycleController = new AbortController();
  let destroyed = false;
  let operationGeneration = 0;
  let projectileNotificationId = null;

  const {
    navigationModeSelect,
    freeflyControls,
    orbitControls,
    planarControls,
    lookSensitivityInput,
    lookSensitivityDisplay,
    moveSpeedInput,
    moveSpeedDisplay,
    invertLookCheckbox,
    projectilesEnabledCheckbox,
    pointerLockCheckbox,
    orbitKeySpeedInput,
    orbitKeySpeedDisplay,
    planarPanSpeedInput,
    planarPanSpeedDisplay,
    orbitReverseCheckbox,
    showOrbitAnchorCheckbox,
    planarZoomToCursorCheckbox,
    planarInvertAxesCheckbox
  } = dom;

  function listen(target, eventName, listener) {
    target.addEventListener(eventName, (...args) => {
      if (destroyed) return;
      listener(...args);
    }, { signal: lifecycleController.signal });
  }

  function ownsOperation(generation) {
    return !destroyed && generation === operationGeneration;
  }

  function toggleNavigationPanels(mode) {
    if (destroyed) return;
    freeflyControls.style.display = mode === 'free' ? 'block' : 'none';
    orbitControls.style.display = mode === 'orbit' ? 'block' : 'none';
    planarControls.style.display = mode === 'planar' ? 'block' : 'none';
  }

  function sliderToLookSensitivity(raw) {
    const v = parseRangeInput(raw, {
      minimum: 1,
      maximum: 30,
      label: 'Look sensitivity'
    });
    return v * 0.0005; // radians per pixel
  }

  function sliderToMoveSpeed(raw) {
    const v = parseRangeInput(raw, {
      minimum: 1,
      maximum: 500,
      label: 'Move speed'
    });
    return v / 100; // scene units per second
  }

  function updateLookSensitivity() {
    if (destroyed) return;
    const rawValue = parseRangeInput(lookSensitivityInput.value, {
      minimum: 1,
      maximum: 30,
      label: 'Look sensitivity'
    });
    const sensitivity = sliderToLookSensitivity(lookSensitivityInput.value);
    lookSensitivityDisplay.textContent = (rawValue / 100).toFixed(2) + 'x';
    viewer.setLookSensitivity(sensitivity);
  }

  function updateMoveSpeed() {
    if (destroyed) return;
    const speed = sliderToMoveSpeed(moveSpeedInput.value);
    moveSpeedDisplay.textContent = speed.toFixed(2) + ' u/s';
    viewer.setMoveSpeed(speed);
  }

  // Keyboard navigation speed sliders for orbit and planar modes
  function updateOrbitKeySpeed() {
    if (destroyed) return;
    const rawValue = parseRangeInput(orbitKeySpeedInput.value, {
      minimum: 1,
      maximum: 100,
      label: 'Orbit keyboard speed'
    });
    const value = rawValue / 100;
    orbitKeySpeedDisplay.textContent = value.toFixed(2) + 'x';
    viewer.setOrbitKeySpeed(value);
  }

  function updatePlanarPanSpeed() {
    if (destroyed) return;
    const rawValue = parseRangeInput(planarPanSpeedInput.value, {
      minimum: 1,
      maximum: 100,
      label: 'Planar keyboard pan speed'
    });
    const t = (rawValue - 1) / 99;
    const value = 0.001 + t * (0.0075 - 0.001);
    planarPanSpeedDisplay.textContent = value.toFixed(4) + 'x';
    viewer.setPlanarPanSpeed(value);
  }

  const applyPointerLock = (checked) => {
    if (destroyed) return;
    const mode = navigationModeSelect.value;
    if (mode !== 'free') {
      pointerLockCheckbox.checked = false;
      return;
    }
    viewer.setPointerLockEnabled(checked);
  };

  listen(navigationModeSelect, 'change', () => {
    viewer.setNavigationMode(navigationModeSelect.value);
    const mode = navigationModeSelect.value;

    // The viewer owns the focused view's exact mode; refresh its badge.
    if (viewer.getCamerasLocked() === false) {
      callbacks.onViewBadgesMaybeChanged();
    }

    if (mode !== 'free') {
      pointerLockCheckbox.checked = false;
      viewer.setPointerLockEnabled(false);
    }

    toggleNavigationPanels(mode);
    navigationModeSelect.blur(); // allow WASD immediately
  });

  updateLookSensitivity();
  listen(lookSensitivityInput, 'input', updateLookSensitivity);

  updateMoveSpeed();
  listen(moveSpeedInput, 'input', updateMoveSpeed);

  updateOrbitKeySpeed();
  listen(orbitKeySpeedInput, 'input', updateOrbitKeySpeed);

  updatePlanarPanSpeed();
  listen(planarPanSpeedInput, 'input', updatePlanarPanSpeed);

  const applyInvertLook = (value) => {
    if (destroyed) return;
    viewer.setInvertLookY(value);
    viewer.setInvertLookX(value);
  };
  applyInvertLook(invertLookCheckbox.checked);
  listen(invertLookCheckbox, 'change', () => {
    applyInvertLook(invertLookCheckbox.checked);
    invertLookCheckbox.blur();
  });

  projectilesEnabledCheckbox.checked = false;
  viewer.setProjectilesEnabled(false);
  listen(projectilesEnabledCheckbox, 'change', () => {
    const enabled = projectilesEnabledCheckbox.checked;

    if (enabled && !viewer.isProjectileSpatialIndexReady()) {
      if (projectileNotificationId !== null) {
        notifications.dismiss(projectileNotificationId);
        projectileNotificationId = null;
      }
      const generation = ++operationGeneration;
      const readyNotifId = notifications.loading('Preparing projectile collision system...', { category: 'spatial' });
      projectileNotificationId = readyNotifId;
      viewer.setProjectilesEnabled(true, (rawResult) => {
        if (!ownsOperation(generation)) return;
        const result = assertProjectileBuildResult(rawResult);
        projectileNotificationId = null;
        if (result.status === 'ready') {
          notifications.complete(
            readyNotifId,
            'Projectiles ready! Click to shoot, hold to charge.'
          );
          return;
        }
        projectilesEnabledCheckbox.checked = false;
        if (result.status === 'cancelled') {
          notifications.dismiss(readyNotifId);
          return;
        }
        notifications.fail(readyNotifId, result.message);
      });
    } else {
      operationGeneration += 1;
      if (projectileNotificationId !== null) {
        notifications.dismiss(projectileNotificationId);
        projectileNotificationId = null;
      }
      viewer.setProjectilesEnabled(enabled);
    }
    projectilesEnabledCheckbox.blur();
  });

  pointerLockCheckbox.checked = false;
  listen(pointerLockCheckbox, 'change', () => {
    applyPointerLock(pointerLockCheckbox.checked);
    pointerLockCheckbox.blur();
  });

  viewer.setPointerLockChangeHandler((active, errorMessage) => {
    if (destroyed) return;
    if (typeof active !== 'boolean') {
      throw new TypeError('Pointer-lock state must be an exact boolean.');
    }
    if (
      errorMessage !== null &&
      (
        typeof errorMessage !== 'string' ||
        errorMessage.length === 0 ||
        errorMessage.trim() !== errorMessage
      )
    ) {
      throw new TypeError(
        'Pointer-lock error must be null or a non-empty trimmed string.'
      );
    }
    pointerLockCheckbox.checked = active;
    if (errorMessage !== null) {
      notifications.error(errorMessage, { category: 'render' });
    }
  });

  viewer.setOrbitInvertRotation(orbitReverseCheckbox.checked);
  listen(orbitReverseCheckbox, 'change', () => {
    viewer.setOrbitInvertRotation(orbitReverseCheckbox.checked);
  });

  viewer.setPlanarZoomToCursor(planarZoomToCursorCheckbox.checked);
  listen(planarZoomToCursorCheckbox, 'change', () => {
    viewer.setPlanarZoomToCursor(planarZoomToCursorCheckbox.checked);
  });

  viewer.setPlanarInvertAxes(planarInvertAxesCheckbox.checked);
  listen(planarInvertAxesCheckbox, 'change', () => {
    viewer.setPlanarInvertAxes(planarInvertAxesCheckbox.checked);
  });

  viewer.setShowOrbitAnchor(showOrbitAnchorCheckbox.checked);
  listen(showOrbitAnchorCheckbox, 'change', () => {
    viewer.setShowOrbitAnchor(showOrbitAnchorCheckbox.checked);
  });

  // Initial navigation panel visibility
  const startingNavMode = viewer.getNavigationMode();
  navigationModeSelect.value = startingNavMode;
  toggleNavigationPanels(startingNavMode);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    operationGeneration += 1;
    lifecycleController.abort();

    const failures = [];
    const cleanup = operation => {
      try {
        operation();
      } catch (error) {
        failures.push(error);
      }
    };
    cleanup(() => viewer.setPointerLockChangeHandler(() => {}));
    cleanup(() => viewer.setPointerLockEnabled(false));
    cleanup(() => viewer.setProjectilesEnabled(false));
    if (projectileNotificationId !== null) {
      const notificationId = projectileNotificationId;
      projectileNotificationId = null;
      cleanup(() => notifications.dismiss(notificationId));
    }
    pointerLockCheckbox.checked = false;
    projectilesEnabledCheckbox.checked = false;

    const exactFailures = [...new Set(failures)];
    if (exactFailures.length === 1) throw exactFailures[0];
    if (exactFailures.length > 1) {
      throw new AggregateError(
        exactFailures,
        'Camera controls failed to release every owned resource.'
      );
    }
  }

  return {
    toggleNavigationPanels,
    updateLookSensitivity,
    updateMoveSpeed,
    updateOrbitKeySpeed,
    updatePlanarPanSpeed,
    destroy
  };
}
