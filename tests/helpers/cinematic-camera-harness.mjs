/**
 * A Camera Path module (`app/ui/modules/cinematic-camera/index.js`) on stub
 * DOM, viewer, navigation panel and dataset source, for node tests: the
 * module environment (document, animation frames), and mounting one module at
 * a time, as the page has one (its camera path actions are provided while it
 * lives).
 */

import { initCinematicCamera } from '../../assets/js/app/ui/modules/cinematic-camera/index.js';
import { cameraStateForOrbitPose } from '../../assets/js/rendering/camera-state-contract.js';
import { representationName } from '../../assets/js/data/representation-names.js';

/** The Camera Path panel's elements, as `index.html` gives them (one list for every test). */
export const CINEMATIC_DOM_KEYS = [
  'saveBtn', 'keyframeList', 'clearBtn', 'timingActions', 'setAllDuration', 'setAllBtn',
  'defaultSpeedInput', 'defaultSpeedDisplay', 'positionInterp',
  'rotationInterp', 'easingSelect', 'loopCheckbox', 'autoplayCheckbox', 'captionsCheckbox'
];

export function createStubElement({ checked = false, value = '' } = {}) {
  const handlers = new Map();
  const names = new Set();
  const children = new Map();
  return {
    checked,
    disabled: false,
    inert: false,
    value,
    innerHTML: '',
    textContent: '',
    clientHeight: 100,
    scrollHeight: 50,
    style: {},
    dataset: {},
    classList: {
      add: name => names.add(name),
      remove: name => names.delete(name),
      contains: name => names.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !names.has(name) : force;
        if (on) names.add(name);
        else names.delete(name);
        return on;
      }
    },
    appendChild() {},
    remove() {},
    blur() {},
    focus() {},
    select() {},
    validationMessage: '',
    setCustomValidity(message) {
      this.validationMessage = message;
    },
    reportValidity() {
      return this.validationMessage === '';
    },
    contains() {
      return false;
    },
    setAttribute() {},
    getAttribute() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    querySelector(selector) {
      if (!children.has(selector)) children.set(selector, createStubElement());
      return children.get(selector);
    },
    addEventListener(type, listener, options = {}) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(listener);
      options.signal?.addEventListener(
        'abort',
        () => {
          handlers.set(
            type,
            handlers.get(type).filter(entry => entry !== listener)
          );
        },
        { once: true }
      );
    },
    removeEventListener(type, listener) {
      handlers.set(
        type,
        (handlers.get(type) ?? []).filter(entry => entry !== listener)
      );
    },
    dispatchEvent(event) {
      for (const listener of [...(handlers.get(event.type) ?? [])]) {
        listener(event);
      }
      return true;
    },
    listeners(type) {
      return [...(handlers.get(type) ?? [])];
    }
  };
}

export function createCinematicDom() {
  const seeds = {
    defaultSpeedInput: { value: '30' },
    positionInterp: { value: 'catmull-rom' },
    rotationInterp: { value: 'slerp' },
    easingSelect: { value: 'linear' },
    setAllDuration: { value: '' }
  };
  const dom = {};
  for (const key of CINEMATIC_DOM_KEYS) dom[key] = createStubElement(seeds[key]);
  // Captions are on in the markup (`#cinematic-captions checked`).
  dom.captionsCheckbox.checked = true;
  return dom;
}

export function installModuleEnvironment() {
  const previous = {
    document: globalThis.document,
    Event: globalThis.Event,
    MutationObserver: globalThis.MutationObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame
  };
  const scheduled = new Map();
  let nextFrameId = 1;
  globalThis.requestAnimationFrame = callback => {
    const id = nextFrameId++;
    scheduled.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = id => {
    scheduled.delete(id);
  };
  if (typeof globalThis.Event !== 'function') {
    globalThis.Event = class StubEvent {
      constructor(type) {
        this.type = type;
      }
    };
  }
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  const sidebar = createStubElement();
  globalThis.document = {
    activeElement: null,
    body: { appendChild() {} },
    createElement: () => createStubElement(),
    getElementById: id => (id === 'sidebar' ? sidebar : null),
    addEventListener() {},
    removeEventListener() {}
  };
  return {
    drainFrames() {
      const pending = [...scheduled];
      scheduled.clear();
      for (const [, callback] of pending) callback(0);
    },
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    }
  };
}

export function createStubViewer(initialMode = 'orbit') {
  let mode = initialMode;
  const camera = {
    navigationMode: initialMode,
    orbit: {
      radius: 3, targetRadius: 3, theta: 0.25, phi: 0.75, target: [0, 0, 0]
    },
    freefly: { position: [0, 0, 3], yaw: -Math.PI / 2, pitch: 0 }
  };
  return {
    place(index, navigationMode) {
      mode = navigationMode;
      camera.navigationMode = navigationMode;
      camera.orbit = {
        radius: 3 + index,
        targetRadius: 3 + index,
        theta: 0.25 * index,
        phi: 0.75,
        target: [index, 0, 0]
      };
      // As the viewer reports a camera: the pose its mode does not drive
      // derived from the one it does (`getCurrentCameraStateInternal`).
      camera.freefly = navigationMode === 'free'
        ? { position: [index, 0, 3 + index], yaw: -Math.PI / 2 + index, pitch: 0.1 * index }
        : cameraStateForOrbitPose({ navigationMode, ...camera.orbit }).freefly;
    },
    // One view, the live one: what a keyframe goto names (`actions/targets/views.js`).
    getFocusedViewId: () => 'live',
    getLiveViewHidden: () => false,
    getSnapshotViews: () => [],
    getNavigationMode: () => mode,
    getCameraState: () => structuredClone(camera),
    setCameraState(value) {
      mode = value.navigationMode;
      camera.navigationMode = value.navigationMode;
      camera.orbit = structuredClone(value.orbit);
      camera.freefly = structuredClone(value.freefly);
    }
  };
}

export function createStubDatasetSource() {
  const listeners = new Set();
  return {
    onDatasetChange: listener => listeners.add(listener),
    offDatasetChange: listener => listeners.delete(listener),
    announce() {
      for (const listener of [...listeners]) listener();
    }
  };
}

/**
 * The Navigation panel as Camera Path sees it: it records every mode it is
 * asked to show (`syncNavigationMode`, the one method Camera Path calls; the
 * navigation settings are settings, not part of a path).
 */
export function createStubNavigation() {
  const modes = [];
  return {
    modes,
    syncNavigationMode(mode) {
      modes.push(mode);
    }
  };
}

/**
 * One Camera Path at a time, as the page has: its camera path actions are
 * provided while it lives (`getActions().provide`), so the previous one is
 * destroyed first. Every module a test mounts is destroyed when it ends,
 * passed or failed (`destroyMounted`).
 */
const mounted = new Set();

export function destroyMounted() {
  for (const module of mounted) module.camera.destroy();
  mounted.clear();
}

/**
 * @param {{focusedRepresentation?: () => ({ref: object|null, name: string}|null)}} [options]
 *   what the focused view shows; nothing by default (a dataset without a mapping)
 */
export function mountCinematicCamera({ focusedRepresentation = () => null } = {}) {
  destroyMounted();
  const dom = createCinematicDom();
  const viewer = createStubViewer();
  const navigation = createStubNavigation();
  const dataSourceManager = createStubDatasetSource();
  const camera = initCinematicCamera({
    viewer,
    dom,
    navigation,
    dataSourceManager,
    focusedRepresentation,
    // A representation's name, as the menus give it: the state's
    // `representationNameOf` is this function given the dataset's obsm
    // arrays; a stub dataset has none.
    representationNameOf: layout => representationName(layout),
  });
  const module = { camera, dom, viewer, navigation, dataSourceManager };
  mounted.add(module);
  return module;
}
