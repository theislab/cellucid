/**
 * @fileoverview Camera + navigation controls.
 *
 * Wires the Navigation panel — the mode dropdown (orbit/planar/free), one
 * settings box per mode, look sensitivity, movement speed, and related toggles
 * (invert look, pointer lock, projectiles, orbit anchor) — to the Viewer API.
 * It is the only owner of these controls: Camera Path reads and restores the
 * navigation settings it records through `exportSettings` and
 * `restoreSettings`, and keeps the panel in step with `syncNavigationMode`.
 *
 * @module ui/modules/camera-controls
 */

import { getNotificationCenter } from '../../notification-center.js';
import { viewerNeedsUiRetirement } from '../core/viewer-lifecycle.js';
import { wireNavigationSettings } from './navigation-settings.js';

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
    throw new TypeError('Navigation controls require a DOM reference object.');
  }
  for (const key of REQUIRED_DOM_KEYS) {
    if (!dom[key]) {
      throw new Error(`Navigation controls are missing the required "${key}" element.`);
    }
  }
  if (
    !callbacks ||
    typeof callbacks !== 'object' ||
    typeof callbacks.onViewBadgesMaybeChanged !== 'function'
  ) {
    throw new TypeError(
      'Navigation controls require onViewBadgesMaybeChanged().'
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

  // The settings block shared with Camera Path: one box per mode, the four
  // speed sliders and the option checkboxes.
  const navigation = wireNavigationSettings({
    viewer,
    dom: {
      orbitControls,
      planarControls,
      freeflyControls,
      orbitKeySpeedInput,
      orbitKeySpeedDisplay,
      planarPanSpeedInput,
      planarPanSpeedDisplay,
      lookSensitivityInput,
      lookSensitivityDisplay,
      moveSpeedInput,
      moveSpeedDisplay,
      orbitReverseCheckbox,
      showOrbitAnchorCheckbox,
      planarZoomToCursorCheckbox,
      planarInvertAxesCheckbox,
      invertLookCheckbox
    },
    listen,
    isDestroyed: () => destroyed,
    owner: 'Navigation'
  });
  const toggleNavigationPanels = navigation.showPanels;

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

  /**
   * Show `mode` in the panel: the select, its settings box, and a pointer
   * capture that only free-fly can hold. Called whenever something other
   * than this select moves the mode (a view switch, a keyframe, playback, a
   * restore).
   */
  function syncNavigationMode(mode) {
    if (destroyed) return;
    navigationModeSelect.value = mode;
    toggleNavigationPanels(mode);
    if (mode !== 'free') pointerLockCheckbox.checked = false;
  }

  /** The navigation settings a camera path records with its keyframes. */
  function exportSettings() {
    return {
      invertLook: invertLookCheckbox.checked,
      lookSensitivity: lookSensitivityInput.value,
      moveSpeed: moveSpeedInput.value,
      orbitKeySpeed: orbitKeySpeedInput.value,
      orbitReverse: orbitReverseCheckbox.checked,
      planarInvertAxes: planarInvertAxesCheckbox.checked,
      planarPanSpeed: planarPanSpeedInput.value,
      planarZoomToCursor: planarZoomToCursorCheckbox.checked,
      showOrbitAnchor: showOrbitAnchorCheckbox.checked
    };
  }

  /** Apply settings recorded by `exportSettings` to the panel and viewer. */
  function restoreSettings(data) {
    if (destroyed) return;
    orbitKeySpeedInput.value = data.orbitKeySpeed;
    navigation.updateOrbitKeySpeed();
    orbitReverseCheckbox.checked = data.orbitReverse;
    viewer.setOrbitInvertRotation(data.orbitReverse);
    showOrbitAnchorCheckbox.checked = data.showOrbitAnchor;
    viewer.setShowOrbitAnchor(data.showOrbitAnchor);

    planarPanSpeedInput.value = data.planarPanSpeed;
    navigation.updatePlanarPanSpeed();
    planarZoomToCursorCheckbox.checked = data.planarZoomToCursor;
    viewer.setPlanarZoomToCursor(data.planarZoomToCursor);
    planarInvertAxesCheckbox.checked = data.planarInvertAxes;
    viewer.setPlanarInvertAxes(data.planarInvertAxes);

    lookSensitivityInput.value = data.lookSensitivity;
    navigation.updateLookSensitivity();
    moveSpeedInput.value = data.moveSpeed;
    navigation.updateMoveSpeed();
    invertLookCheckbox.checked = data.invertLook;
    navigation.applyInvertLook(data.invertLook);
    pointerLockCheckbox.checked = false;
    viewer.setPointerLockEnabled(false);
  }

  // Initial navigation panel visibility
  syncNavigationMode(viewer.getNavigationMode());

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
    if (viewerNeedsUiRetirement(viewer)) {
      cleanup(() => viewer.setPointerLockChangeHandler(() => {}));
      cleanup(() => viewer.setPointerLockEnabled(false));
      cleanup(() => viewer.setProjectilesEnabled(false));
    }
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
    syncNavigationMode,
    exportSettings,
    restoreSettings,
    updateLookSensitivity: navigation.updateLookSensitivity,
    updateMoveSpeed: navigation.updateMoveSpeed,
    updateOrbitKeySpeed: navigation.updateOrbitKeySpeed,
    updatePlanarPanSpeed: navigation.updatePlanarPanSpeed,
    destroy
  };
}
