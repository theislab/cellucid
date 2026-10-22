import assert from 'node:assert/strict';
import test from 'node:test';

import { initCinematicCamera } from '../assets/js/app/ui/modules/cinematic-camera/index.js';

function createControl({ checked = false, value = '' } = {}) {
  const listeners = new Map();
  return {
    checked,
    classList: {
      toggles: 0,
      toggle() {
        this.toggles += 1;
      }
    },
    clientHeight: 100,
    innerHTML: '',
    scrollHeight: 200,
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
    dispatchEvent() {},
    listeners(type) {
      return [...(listeners.get(type) ?? [])];
    }
  };
}

function createDom() {
  const defaults = {
    defaultSpeedInput: { value: '30' },
    positionInterp: { value: 'catmull-rom' },
    rotationInterp: { value: 'slerp' },
    easingSelect: { value: 'linear' },
    setAllDuration: { value: '' }
  };
  const dom = {};
  for (const key of [
    'saveBtn',
    'keyframeList',
    'clearBtn',
    'timingActions',
    'setAllDuration',
    'setAllBtn',
    'defaultSpeedInput',
    'defaultSpeedDisplay',
    'positionInterp',
    'rotationInterp',
    'easingSelect',
    'loopCheckbox',
    'autoplayCheckbox'
  ]) {
    dom[key] = createControl(defaults[key]);
  }
  return dom;
}

test('cinematic-camera destroy cancels and fences DOM and list-frame owners', () => {
  const previousDocument = globalThis.document;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const frames = new Map();
  const cancelledFrames = [];
  let nextFrameId = 1;
  globalThis.requestAnimationFrame = callback => {
    const id = nextFrameId++;
    frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = id => {
    cancelledFrames.push(id);
  };
  globalThis.document = {
    activeElement: null,
    createElement() {
      return {
        innerHTML: '',
        set textContent(value) {
          this.innerHTML = value;
        }
      };
    },
    removeEventListener() {}
  };

  try {
    const dom = createDom();
    const viewerCalls = [];
    const viewer = {
      getNavigationMode() {
        return 'orbit';
      },
      setInvertLookX(value) {
        viewerCalls.push(['setInvertLookX', value]);
      },
      setInvertLookY(value) {
        viewerCalls.push(['setInvertLookY', value]);
      },
      setCameraState(value) {
        viewerCalls.push(['setCameraState', value]);
      },
      setLookSensitivity(value) {
        viewerCalls.push(['setLookSensitivity', value]);
      },
      setMoveSpeed(value) {
        viewerCalls.push(['setMoveSpeed', value]);
      },
      setNavigationMode(value) {
        viewerCalls.push(['setNavigationMode', value]);
      },
      setOrbitInvertRotation(value) {
        viewerCalls.push(['setOrbitInvertRotation', value]);
      },
      setOrbitKeySpeed(value) {
        viewerCalls.push(['setOrbitKeySpeed', value]);
      },
      setPlanarInvertAxes(value) {
        viewerCalls.push(['setPlanarInvertAxes', value]);
      },
      setPlanarPanSpeed(value) {
        viewerCalls.push(['setPlanarPanSpeed', value]);
      },
      setPlanarZoomToCursor(value) {
        viewerCalls.push(['setPlanarZoomToCursor', value]);
      },
      setPointerLockEnabled(value) {
        viewerCalls.push(['setPointerLockEnabled', value]);
      },
      setShowOrbitAnchor(value) {
        viewerCalls.push(['setShowOrbitAnchor', value]);
      }
    };
    const datasetListeners = new Set();
    const dataSourceManager = {
      onDatasetChange(listener) {
        datasetListeners.add(listener);
      },
      offDatasetChange(listener) {
        datasetListeners.delete(listener);
      }
    };
    const navigationCalls = [];
    const navigation = {
      syncNavigationMode(mode) {
        navigationCalls.push(['syncNavigationMode', mode]);
      },
      exportSettings() {
        navigationCalls.push(['exportSettings']);
        return {};
      },
      restoreSettings(data) {
        navigationCalls.push(['restoreSettings', data]);
      }
    };
    const camera = initCinematicCamera({
      viewer,
      dom,
      navigation,
      dataSourceManager,
      focusedRepresentation: () => null,
    });
    const retainedPlaybackController = camera.getPlaybackController();
    camera.getKeyframeStore().add({
      navigationMode: 'orbit',
      orbit: {
        radius: 3,
        targetRadius: 3,
        theta: 0.25,
        phi: 0.75,
        target: [0, 0, 0]
      },
      freefly: {
        position: [0, 0, 3],
        yaw: -Math.PI / 2,
        pitch: 0
      }
    }, undefined, null);
    const retainedSaveListener = dom.saveBtn.listeners('click')[0];
    const [[frameId, retainedFrame]] = frames;
    viewerCalls.length = 0;

    camera.destroy();
    camera.destroy();

    assert.deepEqual(cancelledFrames, [frameId]);
    assert.equal(datasetListeners.size, 0);
    assert.equal(dom.saveBtn.listeners('click').length, 0);
    assert.throws(
      () => retainedPlaybackController.play(),
      /after destruction/i
    );
    assert.throws(() => camera.getPlaybackController(), /after destruction/i);
    assert.throws(() => camera.getKeyframeStore(), /after destruction/i);
    assert.throws(() => camera.capturePlaybackSnapshot(), /after destruction/i);
    assert.throws(() => camera.exportSessionState(), /after destruction/i);
    assert.throws(() => camera.getNavigationMode(), /after destruction/i);

    navigationCalls.length = 0;
    retainedSaveListener();
    retainedFrame(16);
    camera.resetCameraPath();
    camera.startAutoplay();

    assert.deepEqual(viewerCalls, []);
    assert.equal(dom.keyframeList.classList.toggles, 0);
    assert.deepEqual(navigationCalls, []);
  } finally {
    globalThis.document = previousDocument;
    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
    globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
  }
});
