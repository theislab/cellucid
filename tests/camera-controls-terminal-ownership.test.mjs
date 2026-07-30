import assert from 'node:assert/strict';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { initCameraControls } from '../assets/js/app/ui/modules/camera-controls.js';

function createControl({ checked = false, value = '' } = {}) {
  const listeners = new Map();
  return {
    checked,
    style: {},
    value,
    addEventListener(type, listener, options = {}) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          this.removeEventListener(type, listener);
        }, { once: true });
      }
    },
    removeEventListener(type, listener) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter(candidate => candidate !== listener)
      );
    },
    blur() {},
    dispatch(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) {
        listener({ target: this });
      }
    },
    listeners(type) {
      return [...(listeners.get(type) ?? [])];
    }
  };
}

function createHarness() {
  const dom = {
    navigationModeSelect: createControl({ value: 'free' }),
    freeflyControls: createControl(),
    orbitControls: createControl(),
    planarControls: createControl(),
    lookSensitivityInput: createControl({ value: '10' }),
    lookSensitivityDisplay: createControl(),
    moveSpeedInput: createControl({ value: '100' }),
    moveSpeedDisplay: createControl(),
    invertLookCheckbox: createControl(),
    projectilesEnabledCheckbox: createControl(),
    pointerLockCheckbox: createControl(),
    orbitKeySpeedInput: createControl({ value: '50' }),
    orbitKeySpeedDisplay: createControl(),
    planarPanSpeedInput: createControl({ value: '50' }),
    planarPanSpeedDisplay: createControl(),
    orbitReverseCheckbox: createControl(),
    showOrbitAnchorCheckbox: createControl(),
    planarZoomToCursorCheckbox: createControl(),
    planarInvertAxesCheckbox: createControl()
  };
  const calls = [];
  let pointerLockHandler = null;
  let projectileCompletion = null;
  const viewer = {
    getCamerasLocked() {
      return false;
    },
    getNavigationMode() {
      return 'free';
    },
    isProjectileSpatialIndexReady() {
      return false;
    },
    setInvertLookX(value) {
      calls.push(['setInvertLookX', value]);
    },
    setInvertLookY(value) {
      calls.push(['setInvertLookY', value]);
    },
    setLookSensitivity(value) {
      calls.push(['setLookSensitivity', value]);
    },
    setMoveSpeed(value) {
      calls.push(['setMoveSpeed', value]);
    },
    setNavigationMode(value) {
      calls.push(['setNavigationMode', value]);
    },
    setOrbitInvertRotation(value) {
      calls.push(['setOrbitInvertRotation', value]);
    },
    setOrbitKeySpeed(value) {
      calls.push(['setOrbitKeySpeed', value]);
    },
    setPlanarInvertAxes(value) {
      calls.push(['setPlanarInvertAxes', value]);
    },
    setPlanarPanSpeed(value) {
      calls.push(['setPlanarPanSpeed', value]);
    },
    setPlanarZoomToCursor(value) {
      calls.push(['setPlanarZoomToCursor', value]);
    },
    setPointerLockChangeHandler(handler) {
      pointerLockHandler = handler;
      calls.push(['setPointerLockChangeHandler', handler]);
    },
    setPointerLockEnabled(value) {
      calls.push(['setPointerLockEnabled', value]);
    },
    setProjectilesEnabled(value, completion) {
      calls.push(['setProjectilesEnabled', value]);
      if (value && completion) projectileCompletion = completion;
    },
    setShowOrbitAnchor(value) {
      calls.push(['setShowOrbitAnchor', value]);
    }
  };
  return {
    calls,
    dom,
    viewer,
    getPointerLockHandler: () => pointerLockHandler,
    getProjectileCompletion: () => projectileCompletion
  };
}

test('camera-control destroy retires DOM, pointer-lock, and projectile owners', () => {
  const notifications = getNotificationCenter();
  const originalMethods = new Map();
  const notificationCalls = [];
  for (const method of ['complete', 'dismiss', 'error', 'fail', 'loading']) {
    originalMethods.set(method, notifications[method]);
  }
  notifications.loading = (...args) => {
    notificationCalls.push(['loading', ...args]);
    return 'projectile-loading';
  };
  for (const method of ['complete', 'dismiss', 'error', 'fail']) {
    notifications[method] = (...args) => {
      notificationCalls.push([method, ...args]);
    };
  }

  try {
    const harness = createHarness();
    const badgeCalls = [];
    const controls = initCameraControls({
      viewer: harness.viewer,
      dom: harness.dom,
      callbacks: {
        onViewBadgesMaybeChanged() {
          badgeCalls.push('badge');
        }
      }
    });
    harness.calls.length = 0;

    harness.dom.projectilesEnabledCheckbox.checked = true;
    harness.dom.projectilesEnabledCheckbox.dispatch('change');
    const retainedProjectileListener =
      harness.dom.projectilesEnabledCheckbox.listeners('change')[0];
    const retainedPointerHandler = harness.getPointerLockHandler();
    const retainedCompletion = harness.getProjectileCompletion();
    assert.equal(typeof retainedCompletion, 'function');

    controls.destroy();
    controls.destroy();

    assert.deepEqual(
      harness.calls.map(call => call.slice(0, 2)),
      [
        ['setProjectilesEnabled', true],
        ['setPointerLockChangeHandler', harness.getPointerLockHandler()],
        ['setPointerLockEnabled', false],
        ['setProjectilesEnabled', false]
      ]
    );
    assert.equal(
      harness.dom.projectilesEnabledCheckbox.listeners('change').length,
      0
    );
    assert.equal(harness.dom.projectilesEnabledCheckbox.checked, false);
    assert.equal(harness.dom.pointerLockCheckbox.checked, false);
    assert.deepEqual(
      notificationCalls.map(call => call[0]),
      ['loading', 'dismiss']
    );

    harness.calls.length = 0;
    notificationCalls.length = 0;
    retainedProjectileListener();
    retainedPointerHandler(true, 'retained pointer-lock error');
    retainedCompletion(Object.freeze({ status: 'ready', message: null }));
    controls.updateLookSensitivity();
    controls.toggleNavigationPanels('orbit');

    assert.deepEqual(harness.calls, []);
    assert.deepEqual(notificationCalls, []);
    assert.deepEqual(badgeCalls, []);
    assert.equal(harness.dom.projectilesEnabledCheckbox.checked, false);
    assert.equal(harness.dom.pointerLockCheckbox.checked, false);
  } finally {
    for (const [method, implementation] of originalMethods) {
      notifications[method] = implementation;
    }
  }
});
