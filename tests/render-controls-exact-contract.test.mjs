import assert from 'node:assert/strict';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { initRenderControls } from '../assets/js/app/ui/modules/render-controls.js';

class FakeElement {
  constructor({
    value = '',
    min = '',
    max = '',
    step = '',
  } = {}) {
    this.value = value;
    this.min = min;
    this.max = max;
    this.step = step;
    this.textContent = '';
    this.style = {};
    this.listeners = new Map();
    this.classList = {
      toggles: [],
      toggle: (name, force) => {
        this.classList.toggles.push([name, force]);
      },
    };
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ target: this });
    }
  }
}

const INPUT_DEFAULTS = Object.freeze({
  pointSizeInput: ['16.5', '0.5'],
  lightingInput: ['60', '1'],
  fogInput: ['50', '1'],
  sizeAttenuationInput: ['80', '1'],
  smokeGridInput: ['60', '1'],
  smokeStepsInput: ['75', '1'],
  smokeDensityInput: ['56', '1'],
  smokeSpeedInput: ['40', '1'],
  smokeDetailInput: ['60', '1'],
  smokeWarpInput: ['10', '1'],
  smokeAbsorptionInput: ['65', '1'],
  smokeScatterInput: ['0', '1'],
  smokeEdgeInput: ['0', '1'],
  smokeDirectLightInput: ['3', '1'],
  cloudResolutionInput: ['15', '1'],
  noiseResolutionInput: ['58', '1'],
});

const DISPLAY_KEYS = Object.freeze([
  'pointSizeDisplay',
  'lightingDisplay',
  'fogDisplay',
  'sizeAttenuationDisplay',
  'smokeGridDisplay',
  'smokeStepsDisplay',
  'smokeDensityDisplay',
  'smokeSpeedDisplay',
  'smokeDetailDisplay',
  'smokeWarpDisplay',
  'smokeAbsorptionDisplay',
  'smokeScatterDisplay',
  'smokeEdgeDisplay',
  'smokeDirectLightDisplay',
  'cloudResolutionDisplay',
  'noiseResolutionDisplay',
]);

function makeDom() {
  const dom = {
    backgroundSelect: new FakeElement({ value: 'grid' }),
    renderModeSelect: new FakeElement({ value: 'points' }),
    depthControls: new FakeElement(),
    rendererControls: new FakeElement(),
    pointsControls: new FakeElement(),
    smokeControls: new FakeElement(),
  };
  for (const [key, [value, step]] of Object.entries(INPUT_DEFAULTS)) {
    dom[key] = new FakeElement({
      value,
      min: '0',
      max: '100',
      step,
    });
  }
  for (const key of DISPLAY_KEYS) {
    dom[key] = new FakeElement();
  }
  return dom;
}

function makeViewer({ hasSnapshots = false } = {}) {
  const calls = [];
  const viewer = {
    calls,
    setBackground(value) {
      calls.push(['setBackground', value]);
    },
    setRenderMode(value) {
      calls.push(['setRenderMode', value]);
    },
    setPointSize(value) {
      calls.push(['setPointSize', value]);
    },
    setLightingStrength(value) {
      calls.push(['setLightingStrength', value]);
    },
    setFogDensity(value) {
      calls.push(['setFogDensity', value]);
    },
    setSizeAttenuation(value) {
      calls.push(['setSizeAttenuation', value]);
    },
    setSmokeParams(value) {
      calls.push(['setSmokeParams', value]);
    },
    setCloudResolutionScale(value) {
      calls.push(['setCloudResolutionScale', value]);
    },
    setNoiseTextureResolution(value) {
      calls.push(['setNoiseTextureResolution', value]);
    },
    getAdaptiveScaleFactor() {
      calls.push(['getAdaptiveScaleFactor']);
      return 1;
    },
    hasSnapshots() {
      calls.push(['hasSnapshots']);
      return hasSnapshots;
    },
  };
  return viewer;
}

function installDocument(background = 'grid', storage = null) {
  const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const priorStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: {
      documentElement: {
        dataset: {
          viewerBackground: background,
        },
      },
    },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: storage ?? {
      getItem() {
        return null;
      },
      setItem() {
      },
    },
  });
  return () => {
    if (priorDocument === undefined) delete globalThis.document;
    else Object.defineProperty(globalThis, 'document', priorDocument);
    if (priorStorage === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', priorStorage);
  };
}

function makeOptions(viewerOptions) {
  const viewer = makeViewer(viewerOptions);
  const dom = makeDom();
  const smokeCalls = [];
  const smoke = {
    rebuildSmokeDensity(gridSize) {
      smokeCalls.push(gridSize);
    },
  };
  return { viewer, dom, smoke, smokeCalls };
}

test('render controls reject obsolete or open initialization options before mutation', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();

  assert.throws(
    () => initRenderControls({
      viewer,
      dom,
      smoke,
      legacyMode: true,
    }),
    /unexpected.*legacyMode|exact.*keys/i,
  );
  assert.deepEqual(viewer.calls, []);
});

test('render controls preflight every range before any viewer mutation', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();
  dom.smokeDirectLightInput.value = '12px';

  assert.throws(
    () => initRenderControls({ viewer, dom, smoke }),
    /direct light.*exact finite decimal/i,
  );
  assert.deepEqual(viewer.calls, []);
});

test('render controls require the validated bootstrap background exactly', t => {
  const restore = installDocument('sepia');
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();

  assert.throws(
    () => initRenderControls({ viewer, dom, smoke }),
    /viewer background.*grid.*grid-dark.*white.*black/i,
  );
  assert.deepEqual(viewer.calls, []);
});

test('render controls reject unknown initial render mode instead of choosing points', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();
  dom.renderModeSelect.value = 'legacy-points';

  assert.throws(
    () => initRenderControls({ viewer, dom, smoke }),
    /render mode.*points.*smoke/i,
  );
  assert.deepEqual(viewer.calls, []);
});

test('range event failures propagate without publishing substituted values', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();
  initRenderControls({ viewer, dom, smoke });
  const callsBefore = viewer.calls.length;

  dom.fogInput.value = '101';
  assert.throws(
    () => dom.fogInput.dispatch('input'),
    /fog.*between 0 and 100/i,
  );
  assert.equal(viewer.calls.length, callsBefore);
});

test('background persistence failure preserves the current viewer state', t => {
  const storageFailure = new Error('browser storage write error');
  const restore = installDocument('grid', {
    getItem() {
      return null;
    },
    setItem() {
      throw storageFailure;
    },
  });
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();
  initRenderControls({ viewer, dom, smoke });
  const callsBefore = viewer.calls.length;

  dom.backgroundSelect.value = 'black';
  assert.throws(
    () => dom.backgroundSelect.dispatch('change'),
    error => error === storageFailure,
  );
  assert.equal(dom.backgroundSelect.value, 'grid');
  assert.equal(globalThis.document.documentElement.dataset.viewerBackground, 'grid');
  assert.equal(viewer.calls.length, callsBefore);
});

test('public point-size conversion rejects out-of-contract values', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke } = makeOptions();
  const controls = initRenderControls({ viewer, dom, smoke });

  assert.throws(
    () => controls.pointSizeToSlider(0),
    /point size.*between 0\.25 and 200/i,
  );
  assert.throws(
    () => controls.pointSizeToSlider(Number.NaN),
    /point size.*finite number/i,
  );
});

test('smoke conflicts notify and roll back the selector while the public owner rejects', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke, smokeCalls } = makeOptions({ hasSnapshots: true });
  const controls = initRenderControls({ viewer, dom, smoke });
  const notificationCenter = getNotificationCenter();
  const originalWarning = notificationCenter.warning;
  const warnings = [];
  notificationCenter.warning = (message, options) => {
    warnings.push([message, options]);
  };
  t.after(() => {
    notificationCenter.warning = originalWarning;
  });

  dom.renderModeSelect.value = 'smoke';
  dom.renderModeSelect.dispatch('change');
  assert.equal(dom.renderModeSelect.value, 'points');
  assert.deepEqual(smokeCalls, []);
  assert.equal(
    viewer.calls.filter(([method, value]) => method === 'setRenderMode' && value === 'smoke').length,
    0,
  );
  assert.deepEqual(warnings, [[
    'Volumetric smoke requires a single view. Clear snapshots first.',
    { category: 'rendering' },
  ]]);

  assert.throws(
    () => controls.applyRenderMode('smoke'),
    /smoke render mode.*snapshots/i,
  );
});

test('public smoke rebuild requires one explicit exact grid size', t => {
  const restore = installDocument();
  t.after(restore);
  const { viewer, dom, smoke, smokeCalls } = makeOptions();
  const controls = initRenderControls({ viewer, dom, smoke });

  assert.throws(
    () => controls.rebuildSmokeDensity(),
    /grid size.*integer.*at least 8/i,
  );
  assert.throws(
    () => controls.rebuildSmokeDensity('128'),
    /grid size.*integer.*at least 8/i,
  );
  controls.rebuildSmokeDensity(128);
  assert.deepEqual(smokeCalls, [128]);
});

test('current render-control source contains no normalization/default route', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) =>
    readFile(
      new URL('../assets/js/app/ui/modules/render-controls.js', import.meta.url),
      'utf8',
    )
  );
  const numberUtils = await import('node:fs/promises').then(({ readFile }) =>
    readFile(
      new URL('../assets/js/app/utils/number-utils.js', import.meta.url),
      'utf8',
    )
  );

  assert.doesNotMatch(
    source,
    /safeGetStoredViewerBackground|normalizeViewerBackground|clampNormalized|DEFAULT_POINT_SIZE|\?\.\(|set[A-Z][A-Za-z]+\?\./,
  );
  assert.doesNotMatch(
    source,
    /gridSizeOverride\s*===\s*undefined\s*\?\s*smokeGridSize/,
  );
  assert.doesNotMatch(numberUtils, /export function clampNormalized\\b/);
});
