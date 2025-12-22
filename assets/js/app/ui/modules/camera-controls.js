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
import { clamp } from '../../utils/number-utils.js';

const LIVE_VIEW_ID = 'live';

/**
 * @param {object} options
 * @param {object} options.viewer
 * @param {object} options.dom
 * @param {HTMLSelectElement|null} options.dom.navigationModeSelect
 * @param {HTMLElement|null} options.dom.freeflyControls
 * @param {HTMLElement|null} options.dom.orbitControls
 * @param {HTMLElement|null} options.dom.planarControls
 * @param {HTMLInputElement|null} options.dom.lookSensitivityInput
 * @param {HTMLElement|null} options.dom.lookSensitivityDisplay
 * @param {HTMLInputElement|null} options.dom.moveSpeedInput
 * @param {HTMLElement|null} options.dom.moveSpeedDisplay
 * @param {HTMLInputElement|null} options.dom.invertLookCheckbox
 * @param {HTMLInputElement|null} options.dom.projectilesEnabledCheckbox
 * @param {HTMLInputElement|null} options.dom.pointerLockCheckbox
 * @param {HTMLInputElement|null} options.dom.orbitKeySpeedInput
 * @param {HTMLElement|null} options.dom.orbitKeySpeedDisplay
 * @param {HTMLInputElement|null} options.dom.planarPanSpeedInput
 * @param {HTMLElement|null} options.dom.planarPanSpeedDisplay
 * @param {HTMLInputElement|null} options.dom.orbitReverseCheckbox
 * @param {HTMLInputElement|null} options.dom.showOrbitAnchorCheckbox
 * @param {HTMLInputElement|null} options.dom.planarZoomToCursorCheckbox
 * @param {HTMLInputElement|null} options.dom.planarInvertAxesCheckbox
 * @param {{ onViewBadgesMaybeChanged?: () => void }} [options.callbacks]
 */
export function initCameraControls({ viewer, dom, callbacks = {} }) {
  const navigationModeSelect = dom?.navigationModeSelect || null;
  const freeflyControls = dom?.freeflyControls || null;
  const orbitControls = dom?.orbitControls || null;
  const planarControls = dom?.planarControls || null;

  const lookSensitivityInput = dom?.lookSensitivityInput || null;
  const lookSensitivityDisplay = dom?.lookSensitivityDisplay || null;
  const moveSpeedInput = dom?.moveSpeedInput || null;
  const moveSpeedDisplay = dom?.moveSpeedDisplay || null;

  const invertLookCheckbox = dom?.invertLookCheckbox || null;
  const projectilesEnabledCheckbox = dom?.projectilesEnabledCheckbox || null;
  const pointerLockCheckbox = dom?.pointerLockCheckbox || null;

  const orbitKeySpeedInput = dom?.orbitKeySpeedInput || null;
  const orbitKeySpeedDisplay = dom?.orbitKeySpeedDisplay || null;
  const planarPanSpeedInput = dom?.planarPanSpeedInput || null;
  const planarPanSpeedDisplay = dom?.planarPanSpeedDisplay || null;

  const orbitReverseCheckbox = dom?.orbitReverseCheckbox || null;
  const showOrbitAnchorCheckbox = dom?.showOrbitAnchorCheckbox || null;
  const planarZoomToCursorCheckbox = dom?.planarZoomToCursorCheckbox || null;
  const planarInvertAxesCheckbox = dom?.planarInvertAxesCheckbox || null;

  function toggleNavigationPanels(mode) {
    if (freeflyControls) {
      freeflyControls.style.display = mode === 'free' ? 'block' : 'none';
    }
    if (orbitControls) {
      orbitControls.style.display = mode === 'orbit' ? 'block' : 'none';
    }
    if (planarControls) {
      planarControls.style.display = mode === 'planar' ? 'block' : 'none';
    }
  }

  function sliderToLookSensitivity(raw) {
    const v = clamp(parseFloat(raw) || 5, 1, 30);
    return v * 0.0005; // radians per pixel
  }

  function sliderToMoveSpeed(raw) {
    const v = clamp(parseFloat(raw) || 100, 1, 500);
    return v / 100; // scene units per second
  }

  function updateLookSensitivity() {
    if (!lookSensitivityInput) return;
    const sensitivity = sliderToLookSensitivity(lookSensitivityInput.value);
    if (lookSensitivityDisplay) {
      lookSensitivityDisplay.textContent = (parseFloat(lookSensitivityInput.value) / 100).toFixed(2) + 'x';
    }
    viewer.setLookSensitivity?.(sensitivity);
  }

  function updateMoveSpeed() {
    if (!moveSpeedInput) return;
    const speed = sliderToMoveSpeed(moveSpeedInput.value);
    if (moveSpeedDisplay) {
      moveSpeedDisplay.textContent = speed.toFixed(2) + ' u/s';
    }
    viewer.setMoveSpeed?.(speed);
  }

  // Keyboard navigation speed sliders for orbit and planar modes
  function updateOrbitKeySpeed() {
    if (!orbitKeySpeedInput) return;
    const value = parseFloat(orbitKeySpeedInput.value) / 100;
    if (orbitKeySpeedDisplay) {
      orbitKeySpeedDisplay.textContent = value.toFixed(2) + 'x';
    }
    viewer.setOrbitKeySpeed?.(value);
  }

  function updatePlanarPanSpeed() {
    if (!planarPanSpeedInput) return;
    const t = (parseFloat(planarPanSpeedInput.value) - 1) / 99;
    const value = 0.001 + t * (0.0075 - 0.001);
    if (planarPanSpeedDisplay) {
      planarPanSpeedDisplay.textContent = value.toFixed(4) + 'x';
    }
    viewer.setPlanarPanSpeed?.(value);
  }

  const applyPointerLock = (checked) => {
    if (!pointerLockCheckbox || !viewer.setPointerLockEnabled) return;
    const mode = navigationModeSelect?.value === 'free' ? 'free' : 'orbit';
    if (mode !== 'free') {
      pointerLockCheckbox.checked = false;
      return;
    }
    viewer.setPointerLockEnabled(Boolean(checked));
  };

  if (navigationModeSelect) {
    navigationModeSelect.addEventListener('change', () => {
      const selectValue = navigationModeSelect.value;
      const mode = selectValue === 'free' ? 'free' : (selectValue === 'planar' ? 'planar' : 'orbit');
      viewer.setNavigationMode?.(mode);

      // When cameras are unlocked, also update the focused view's stored navigation mode.
      const camerasLocked = typeof viewer.getCamerasLocked === 'function' ? viewer.getCamerasLocked() : true;
      if (!camerasLocked && typeof viewer.setViewNavigationMode === 'function') {
        const focusedId = typeof viewer.getFocusedViewId === 'function' ? viewer.getFocusedViewId() : LIVE_VIEW_ID;
        viewer.setViewNavigationMode(focusedId, mode);
        callbacks.onViewBadgesMaybeChanged?.();
      }

      if (mode !== 'free' && pointerLockCheckbox && viewer.setPointerLockEnabled) {
        pointerLockCheckbox.checked = false;
        viewer.setPointerLockEnabled(false);
      }

      toggleNavigationPanels(mode);
      navigationModeSelect.blur(); // allow WASD immediately
    });
  }

  if (lookSensitivityInput) {
    updateLookSensitivity();
    lookSensitivityInput.addEventListener('input', updateLookSensitivity);
  }

  if (moveSpeedInput) {
    updateMoveSpeed();
    moveSpeedInput.addEventListener('input', updateMoveSpeed);
  }

  if (orbitKeySpeedInput) {
    updateOrbitKeySpeed();
    orbitKeySpeedInput.addEventListener('input', updateOrbitKeySpeed);
  }

  if (planarPanSpeedInput) {
    updatePlanarPanSpeed();
    planarPanSpeedInput.addEventListener('input', updatePlanarPanSpeed);
  }

  if (invertLookCheckbox && viewer.setInvertLook) {
    const setY = viewer.setInvertLookY || viewer.setInvertLook;
    const setX = viewer.setInvertLookX || viewer.setInvertLook;
    const apply = (val) => {
      setY.call(viewer, val);
      setX.call(viewer, val);
    };
    apply(Boolean(invertLookCheckbox.checked));
    invertLookCheckbox.addEventListener('change', () => {
      apply(Boolean(invertLookCheckbox.checked));
      invertLookCheckbox.blur();
    });
  }

  if (projectilesEnabledCheckbox && viewer.setProjectilesEnabled) {
    projectilesEnabledCheckbox.checked = false;
    viewer.setProjectilesEnabled(false);
    projectilesEnabledCheckbox.addEventListener('change', () => {
      const enabled = projectilesEnabledCheckbox.checked;

      if (enabled && !viewer.isProjectileSpatialIndexReady?.()) {
        const notifications = getNotificationCenter();
        const readyNotifId = notifications.loading('Preparing projectile collision system...', { category: 'spatial' });
        viewer.setProjectilesEnabled(true, () => {
          notifications.complete(readyNotifId, 'Projectiles ready! Click to shoot, hold to charge.');
        });
      } else {
        viewer.setProjectilesEnabled(enabled);
      }
      projectilesEnabledCheckbox.blur();
    });
  }

  if (pointerLockCheckbox && viewer.setPointerLockEnabled) {
    pointerLockCheckbox.checked = false;
    pointerLockCheckbox.addEventListener('change', () => {
      applyPointerLock(pointerLockCheckbox.checked);
      pointerLockCheckbox.blur();
    });
  }

  if (pointerLockCheckbox && viewer.setPointerLockChangeHandler) {
    viewer.setPointerLockChangeHandler((active) => {
      pointerLockCheckbox.checked = active;
      if (!active && viewer.getNavigationMode && viewer.getNavigationMode() !== 'free') {
        pointerLockCheckbox.checked = false;
      }
    });
  }

  if (orbitReverseCheckbox && viewer.setOrbitInvertRotation) {
    viewer.setOrbitInvertRotation(Boolean(orbitReverseCheckbox.checked));
    orbitReverseCheckbox.addEventListener('change', () => {
      viewer.setOrbitInvertRotation(Boolean(orbitReverseCheckbox.checked));
    });
  }

  if (planarZoomToCursorCheckbox && viewer.setPlanarZoomToCursor) {
    viewer.setPlanarZoomToCursor(Boolean(planarZoomToCursorCheckbox.checked));
    planarZoomToCursorCheckbox.addEventListener('change', () => {
      viewer.setPlanarZoomToCursor(Boolean(planarZoomToCursorCheckbox.checked));
    });
  }

  if (planarInvertAxesCheckbox && viewer.setPlanarInvertAxes) {
    viewer.setPlanarInvertAxes(Boolean(planarInvertAxesCheckbox.checked));
    planarInvertAxesCheckbox.addEventListener('change', () => {
      viewer.setPlanarInvertAxes(Boolean(planarInvertAxesCheckbox.checked));
    });
  }

  if (showOrbitAnchorCheckbox && viewer.setShowOrbitAnchor) {
    viewer.setShowOrbitAnchor(Boolean(showOrbitAnchorCheckbox.checked));
    showOrbitAnchorCheckbox.addEventListener('change', () => {
      viewer.setShowOrbitAnchor(Boolean(showOrbitAnchorCheckbox.checked));
    });
  }

  // Initial navigation panel visibility
  const startingNavMode = navigationModeSelect?.value || 'orbit';
  toggleNavigationPanels(startingNavMode);

  return {
    toggleNavigationPanels,
    updateLookSensitivity,
    updateMoveSpeed,
    updateOrbitKeySpeed,
    updatePlanarPanSpeed
  };
}
