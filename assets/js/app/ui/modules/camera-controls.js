/**
 * @fileoverview Camera + navigation controls.
 *
 * Wires the Navigation panel — the mode dropdown (orbit/planar/free), one
 * settings box per mode, look sensitivity, movement speed, and related toggles
 * (invert look, pointer lock, projectiles, orbit anchor) — to the Viewer API.
 * It is the only owner of these controls; their values are settings (the
 * generic control inventory, `state-serializer/ui-controls.js`), and Camera
 * Path keeps the panel in step with the mode through `syncNavigationMode`.
 *
 * It implements the camera actions (`app/actions/definitions/camera.js`):
 * `camera.set`, `camera.reset` and `camera.navigation.set`. The mode select
 * (and the O, P and G keys, which turn it) dispatches; a camera gesture is
 * recorded by observation: each time the viewer says the camera settled
 * (`camera-settled`), one `camera.set` names the focused view and the camera
 * it settled at. The history compares it with what it shows, so the settle a
 * restore, a dispatched camera change or a camera path causes is no second
 * step. A gesture by keys (W, A, S, D, Q, E, the zoom keys) is recorded
 * exactly as a drag is: the glide it leaves settles once. An action on the
 * cameras that starts while the camera still moves ends the gesture there
 * and records it first, so no camera motion reaches the history as a change
 * made outside an action. Views are named as the Compare views list numbers
 * them (`app/actions/targets/views.js`).
 *
 * @module ui/modules/camera-controls
 */

import { getNotificationCenter } from '../../notification-center.js';
import { viewerNeedsUiRetirement } from '../core/viewer-lifecycle.js';
import { wireNavigationSettings } from './navigation-settings.js';
import { getActions } from '../../actions/index.js';
import { ActionRefused } from '../../actions/dispatcher.js';
import { dispatchFromControl } from '../../actions/control-dispatch.js';
import { resolveViewName, viewNameOf } from '../../actions/targets/views.js';
import {
  assertNavigationMode,
  createDefaultCameraPose,
  isExactCameraState,
} from '../../../rendering/camera-state-contract.js';

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
    const mode = navigationModeSelect.value;
    navigationModeSelect.blur(); // allow WASD immediately
    void dispatchFromControl(
      'camera.navigation.set',
      { view: viewNameOf(viewer, viewer.getFocusedViewId()), mode },
      { failure: 'Navigation change failed', category: 'render' }
    ).then(result => {
      // Not applied: the panel shows the mode the view has.
      if (result === null && !destroyed) syncNavigationMode(viewer.getNavigationMode());
    });
  });

  /**
   * Navigate one view by `mode`. The focused view's mode is the panel's: the
   * select, its settings box, and a pointer capture only free-fly holds.
   */
  function setViewNavigation(viewId, mode) {
    const exactMode = assertNavigationMode(mode);
    if (viewId === viewer.getFocusedViewId()) {
      viewer.setNavigationMode(exactMode);
      if (exactMode !== 'free') viewer.setPointerLockEnabled(false);
      syncNavigationMode(exactMode);
    } else {
      viewer.setViewNavigationMode(viewId, exactMode);
    }
    callbacks.onViewBadgesMaybeChanged();
  }

  /** Put `viewId`'s camera at `camera` (views linked to it follow). */
  function setViewCamera(viewId, camera) {
    if (!isExactCameraState(camera)) {
      throw new ActionRefused('A camera needs its navigation mode and complete orbit and free-fly poses, with a radius above 0.');
    }
    viewer.setViewCameraState(viewId, camera);
    if (viewId === viewer.getFocusedViewId()) syncNavigationMode(viewer.getNavigationMode());
    callbacks.onViewBadgesMaybeChanged();
  }

  /**
   * Put `viewId`'s camera back to the starting pose, in its own navigation
   * mode. The focused view's reset also lets go of a pointer capture and the
   * projectiles (`viewer.resetCamera`).
   */
  function resetViewCamera(viewId) {
    if (viewId === viewer.getFocusedViewId()) {
      viewer.resetCamera();
      return;
    }
    const pose = createDefaultCameraPose();
    viewer.setViewCameraState(viewId, {
      navigationMode: viewer.getViewNavigationMode(viewId),
      orbit: { ...pose.orbit, targetRadius: pose.orbit.radius },
      freefly: pose.freefly,
    });
  }

  function requireLiveControls() {
    if (destroyed) throw new ActionRefused('The camera controls are closed.', { code: 'unavailable' });
  }

  const actions = getActions();
  const withdrawals = [
    actions.provide('camera.navigation.set', ({ view, mode }) => {
      requireLiveControls();
      setViewNavigation(resolveViewName(viewer, view), mode);
      return { view, mode };
    }),
    actions.provide('camera.set', ({ view, camera }) => {
      requireLiveControls();
      setViewCamera(resolveViewName(viewer, view), camera);
      return { view };
    }),
    actions.provide('camera.reset', ({ view }) => {
      requireLiveControls();
      resetViewCamera(resolveViewName(viewer, view));
      return { view };
    }),
  ];

  /** Record where `viewId`'s camera is now as the gesture that moved it (`camera.set`, observed). */
  function recordGesture(viewId) {
    try {
      getActions()
        .recordObserved('camera.set', {
          view: viewNameOf(viewer, viewId),
          camera: viewer.getViewCameraState(viewId),
        })
        .catch(error => console.error('[CameraControls] A camera gesture could not be recorded.', error));
    } catch (error) {
      console.error('[CameraControls] A camera gesture could not be recorded.', error);
    }
  }

  // A camera gesture (a drag, a wheel, keys, a camera path played) ends when
  // the viewer says the camera settled: one step, synchronously, so a settle a
  // restore caused is compared with what the history shows and dropped.
  const stopObservingCamera = viewer.onPresentedViewStateChanged(event => {
    if (destroyed || event.reason !== 'camera-settled') return;
    recordGesture(event.viewId);
  });

  /**
   * End a gesture that has not settled yet where it is: the camera stops
   * where it is shown (the glide a key or a drag leaves, a zoom easing) and
   * the gesture is recorded at once. Its own settle comes later and finds
   * the history showing it already, so it records nothing twice. Nothing
   * happens while the camera is at rest.
   */
  function endGesture() {
    if (destroyed || !viewer.isCameraInMotion()) return;
    viewer.stopInertia();
    recordGesture(viewer.getFocusedViewId());
  }

  // An action on the cameras that starts while the camera still moves (O
  // pressed right after W, R or a view chosen mid-glide, an agent's camera)
  // ends the gesture first, so the action starts from it. Otherwise the
  // action's step met a camera moved with no step, a change made outside an
  // action. The history's own re-application of a step is left alone.
  const stopSettlingBeforeActions = getActions().subscribe(event => {
    if (destroyed || event.kind !== 'start' || event.meta.internal || event.meta.rewrite !== null) return;
    if (getActions().catalog.get(event.type).touches.includes('camera')) endGesture();
  });
  // A move of the history (undo pressed right after a drag) ends it too, so
  // undo undoes the gesture rather than the step before it (the dispatcher's
  // settlers, which the history runs before it moves).
  const removeSettler = getActions().addSettler(endGesture);

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
            'Projectiles ready! Click to shoot, hold to charge.',
            { announce: true }
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
    cleanup(stopObservingCamera);
    cleanup(stopSettlingBeforeActions);
    cleanup(removeSettler);
    for (const withdraw of withdrawals) cleanup(withdraw);
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
    updateLookSensitivity: navigation.updateLookSensitivity,
    updateMoveSpeed: navigation.updateMoveSpeed,
    updateOrbitKeySpeed: navigation.updateOrbitKeySpeed,
    updatePlanarPanSpeed: navigation.updatePlanarPanSpeed,
    destroy
  };
}
