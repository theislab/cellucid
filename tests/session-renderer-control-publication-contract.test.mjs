/**
 * A restored session must reach the renderer, not only the panel (CEL-0129).
 *
 * `state-serializer/ui-controls.js` restores a control by writing the DOM and
 * dispatching the event the control's owner listens for. That is the whole
 * publication mechanism: a dispatched event with no listener does nothing, so a
 * control whose listener does not yet exist restores into the DOM and stops
 * there. `main.js` restores the advertised dataset state in the middle of its
 * linear bootstrap, and the four renderer controls — shader quality, adaptive
 * LOD, forced LOD level, frustum culling — used to be wired inline at the far
 * end of it. Their saved values were written into the panel and never published
 * to the viewer, so the panel claimed a setting the renderer was never told
 * about.
 *
 * The correction gives those four controls the owner every other control in the
 * same accordion already has: `ui/modules/render-controls.js`, initialized by
 * `initUI` before the bootstrap restores anything. These tests hold both halves
 * — that the wiring exists there and publishes, and that nothing publishes them
 * from the bootstrap tail again.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createUiControlSerializer } from '../assets/js/app/state-serializer/ui-controls.js';
import { initRenderControls } from '../assets/js/app/ui/modules/render-controls.js';
import {
  POINT_SIZE_SLIDER_MINIMUM,
} from '../assets/js/rendering/point-size-scale.js';

const MAIN_URL = new URL('../assets/js/app/main.js', import.meta.url);
const DOM_CACHE_URL = new URL(
  '../assets/js/app/ui/core/dom-cache.js',
  import.meta.url
);
const INDEX_URL = new URL('../index.html', import.meta.url);

const [mainSource, domCacheSource, indexHtml] = await Promise.all([
  readFile(MAIN_URL, 'utf8'),
  readFile(DOM_CACHE_URL, 'utf8'),
  readFile(INDEX_URL, 'utf8'),
]);

// ---------------------------------------------------------------------------
// Fake DOM shared by the render-controls wiring and the session serializer.
// The same element objects are handed to both, which is what makes this a test
// of publication rather than of two independent mocks.
// ---------------------------------------------------------------------------

class FakeElement {
  constructor({
    id = '',
    tagName = 'INPUT',
    type = '',
    value = '',
    checked = false,
    min = '',
    max = '',
    step = '',
    options = [],
    hidden = false,
  } = {}) {
    this.id = id;
    this.tagName = tagName;
    this.type = type;
    this.value = value;
    this.hidden = hidden;
    this.checked = checked;
    this.min = min;
    this.max = max;
    this.step = step;
    this.options = options.map(optionValue => ({ value: optionValue }));
    this.textContent = '';
    this.style = {};
    this.listeners = new Map();
    this.classList = {
      toggle: () => {},
    };
  }

  closest() {
    return null;
  }

  addEventListener(type, listener, options = {}) {
    if (options.signal?.aborted) return;
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
    if (options.signal) {
      options.signal.addEventListener(
        'abort',
        () => this.removeEventListener(type, listener),
        { once: true }
      );
    }
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      listeners.filter(candidate => candidate !== listener)
    );
  }

  dispatchEvent(event) {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
      listener({ target: this, type: event.type });
    }
    return true;
  }
}

const SLIDER_DEFAULTS = Object.freeze({
  pointSizeInput: ['16.5', '0.5', String(POINT_SIZE_SLIDER_MINIMUM)],
  lightingInput: ['60', '1'],
  fogInput: ['50', '1'],
  sizeAttenuationInput: ['80', '1'],
  smokeGridInput: ['80', '1'],
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

/** The four session-serialized renderer controls, in `index.html` order. */
function makeRendererControls() {
  return {
    hpLodEnabledCheckbox: new FakeElement({
      id: 'hp-lod-enabled',
      type: 'checkbox',
      checked: false,
    }),
    hpFrustumCullingCheckbox: new FakeElement({
      id: 'hp-frustum-culling',
      type: 'checkbox',
      checked: false,
    }),
    hpShaderQualitySelect: new FakeElement({
      id: 'hp-shader-quality',
      tagName: 'SELECT',
      value: 'full',
      options: ['full', 'light', 'ultralight'],
    }),
    hpLodForceInput: new FakeElement({
      id: 'hp-lod-force',
      type: 'range',
      value: '-1',
      min: '-1',
      max: '17',
      step: '1',
    }),
    hpLodForceContainer: new FakeElement({ id: 'lod-force-container' }),
    hpLodForceDisplay: new FakeElement({ id: 'hp-lod-force-label' }),
    // Antialiasing belongs to the same module but publishes to storage rather
    // than to the viewer, because it is a context-creation attribute. It is
    // here so this fake DOM stays the module's real inventory; its own
    // behaviour is held by `antialias-setting-contract.test.mjs`.
    hpAntialiasCheckbox: new FakeElement({
      id: 'hp-antialias',
      type: 'checkbox',
      checked: true,
    }),
    hpAntialiasStatus: new FakeElement({ id: 'hp-antialias-status' }),
  };
}

function makeDom(renderer) {
  const dom = {
    backgroundSelect: new FakeElement({ tagName: 'SELECT', value: 'grid' }),
    renderModeSelect: new FakeElement({ tagName: 'SELECT', value: 'points' }),
    renderModeMaturityTag: new FakeElement({ hidden: true }),
    depthControls: new FakeElement(),
    rendererControls: new FakeElement(),
    pointsControls: new FakeElement(),
    smokeControls: new FakeElement(),
    ...renderer,
  };
  for (const [key, [value, step, min = '0']] of Object.entries(SLIDER_DEFAULTS)) {
    dom[key] = new FakeElement({ value, min, max: '100', step });
  }
  for (const key of DISPLAY_KEYS) dom[key] = new FakeElement();
  return dom;
}

function makeViewer(overrides = {}) {
  const calls = [];
  return {
    calls,
    setBackground: () => calls.push(['setBackground']),
    setRenderMode: () => calls.push(['setRenderMode']),
    setPointSize: () => calls.push(['setPointSize']),
    setLightingStrength: () => calls.push(['setLightingStrength']),
    setFogDensity: () => calls.push(['setFogDensity']),
    setSizeAttenuation: () => calls.push(['setSizeAttenuation']),
    setSmokeParams: () => calls.push(['setSmokeParams']),
    setCloudResolutionScale: () => calls.push(['setCloudResolutionScale']),
    setNoiseTextureResolution: () => calls.push(['setNoiseTextureResolution']),
    getAdaptiveScaleFactor: () => 1,
    hasSnapshots: () => false,
    setShaderQuality: value => calls.push(['setShaderQuality', value]),
    setAdaptiveLOD: value => calls.push(['setAdaptiveLOD', value]),
    setForceLOD: value => calls.push(['setForceLOD', value]),
    setFrustumCulling: value => calls.push(['setFrustumCulling', value]),
    setAntialiasing: value => {
      calls.push(['setAntialiasing', value]);
      return value;
    },
    getAntialiasing: () => false,
    isAntialiasingAvailable: () => true,
    ...overrides,
  };
}

function installDocument() {
  const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const priorStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    'localStorage'
  );
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: {
      documentElement: { dataset: { viewerBackground: 'grid' } },
      // The session serializer looks the floating-panel root up by id.
      getElementById: () => null,
    },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
  });
  return () => {
    if (priorDocument === undefined) delete globalThis.document;
    else Object.defineProperty(globalThis, 'document', priorDocument);
    if (priorStorage === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', priorStorage);
  };
}

/** A sidebar holding exactly the four session-serialized renderer controls. */
function makeSidebar(renderer) {
  const controls = [
    renderer.hpLodEnabledCheckbox,
    renderer.hpFrustumCullingCheckbox,
    renderer.hpAntialiasCheckbox,
    renderer.hpShaderQualitySelect,
    renderer.hpLodForceInput,
  ];
  return {
    querySelectorAll(selector) {
      if (selector === 'input[id]') {
        return controls.filter(control => control.tagName === 'INPUT');
      }
      if (selector === 'select[id]') {
        return controls.filter(control => control.tagName === 'SELECT');
      }
      if (selector === 'details.accordion-section') return [];
      // The renderer controls are inputs and selects only; this fixture holds
      // no pressed-button group.
      if (selector === '[data-state-serializer-pressed-group]') return [];
      throw new Error(`Unexpected sidebar selector ${selector}`);
    },
  };
}

/**
 * The bootstrap, in order: wire the renderer controls through their owner, then
 * restore a saved session over the same elements.
 */
function bootstrapAndRestore(savedControls, { viewer: viewerOverrides } = {}) {
  const renderer = makeRendererControls();
  const dom = makeDom(renderer);
  const viewer = makeViewer(viewerOverrides);
  const renderControls = initRenderControls({
    viewer,
    dom,
    smoke: { rebuildSmokeDensity: () => {} },
  });
  const publishedBeforeRestore = viewer.calls.length;
  const serializer = createUiControlSerializer({
    sidebar: makeSidebar(renderer),
  });
  serializer.restoreUIControls(savedControls);
  return {
    renderer,
    renderControls,
    viewer,
    rendererCalls: viewer.calls
      .slice(publishedBeforeRestore)
      .filter(([method]) => method.startsWith('set') && [
        'setShaderQuality',
        'setAdaptiveLOD',
        'setForceLOD',
        'setFrustumCulling',
      ].includes(method)),
  };
}

const SAVED_SESSION = Object.freeze({
  'hp-lod-enabled': { type: 'checkbox', checked: true },
  'hp-frustum-culling': { type: 'checkbox', checked: true },
  'hp-antialias': { type: 'checkbox', checked: true },
  'hp-shader-quality': { type: 'select', value: 'light' },
  'hp-lod-force': { type: 'range', value: '5' },
});

test('a restored session publishes every renderer setting to the viewer', t => {
  t.after(installDocument());

  const { rendererCalls } = bootstrapAndRestore(structuredClone(SAVED_SESSION));

  assert.ok(
    rendererCalls.some(
      ([method, value]) => method === 'setShaderQuality' && value === 'light'
    ),
    'the restored shader quality must reach the viewer'
  );
  assert.ok(
    rendererCalls.some(
      ([method, value]) => method === 'setAdaptiveLOD' && value === true
    ),
    'the restored adaptive-LOD state must reach the viewer'
  );
  assert.ok(
    rendererCalls.some(
      ([method, value]) => method === 'setFrustumCulling' && value === true
    ),
    'the restored frustum-culling state must reach the viewer'
  );
  assert.ok(
    rendererCalls.some(([method]) => method === 'setForceLOD'),
    'the restored forced LOD level must reach the viewer'
  );
});

test('the forced LOD level survives the adaptive-LOD toggle that precedes it', t => {
  t.after(installDocument());

  // Enabling adaptive LOD resets the forced level to auto, in the renderer and
  // in the panel. The serializer restores checkboxes before ranges, so the
  // forced level is republished afterwards and must win.
  const { renderer, rendererCalls } = bootstrapAndRestore(
    structuredClone(SAVED_SESSION)
  );

  const forcedLevels = rendererCalls
    .filter(([method]) => method === 'setForceLOD')
    .map(([, value]) => value);
  assert.deepEqual(
    forcedLevels.at(-1),
    5,
    'the last forced level published must be the saved one'
  );
  assert.equal(renderer.hpLodForceInput.value, '5');
  assert.equal(
    renderer.hpLodForceDisplay.textContent,
    '5',
    'the forced-level readout must agree with the published level'
  );
  assert.equal(
    renderer.hpLodForceContainer.style.display,
    'block',
    'the forced-level row must be shown when adaptive LOD is on'
  );
});

test('a renderer that rejects a restored setting fails the restore loudly', t => {
  t.after(installDocument());

  // Silence is the defect this whole finding is about: a rejected setting must
  // roll the control back, which the serializer then reports as a rejected
  // restore rather than leaving a panel that disagrees with the renderer.
  assert.throws(
    () =>
      bootstrapAndRestore(structuredClone(SAVED_SESSION), {
        viewer: {
          setAdaptiveLOD() {
            throw new Error('Spatial indices are unavailable.');
          },
        },
      }),
    /hp-lod-enabled.*rejected/s
  );
});

test('restoring the values a control already holds publishes nothing', t => {
  t.after(installDocument());

  const { rendererCalls } = bootstrapAndRestore({
    'hp-lod-enabled': { type: 'checkbox', checked: false },
    'hp-frustum-culling': { type: 'checkbox', checked: false },
    'hp-antialias': { type: 'checkbox', checked: true },
    'hp-shader-quality': { type: 'select', value: 'full' },
    'hp-lod-force': { type: 'range', value: '-1' },
  });

  assert.deepEqual(
    rendererCalls,
    [],
    'an unchanged restore must not disturb the renderer'
  );
});

test('renderer control ownership stays out of the bootstrap tail', () => {
  // The bootstrap wires `initUI` in its middle and used to wire these four
  // controls at its end, past the restore. Publishing from `main.js` at all is
  // what reintroduces that ordering, so the ownership is asserted, not the line
  // numbers.
  for (const method of [
    'setShaderQuality',
    'setAdaptiveLOD',
    'setForceLOD',
    'setFrustumCulling',
  ]) {
    assert.ok(
      !mainSource.includes(`viewer.${method}(`),
      `main.js must not publish ${method} itself; render-controls owns it`
    );
  }

  const initUi = mainSource.indexOf('ui = initUI({');
  const initialRestore = mainSource.lastIndexOf(
    'stateOutcome = await restoreAdvertisedDatasetState({'
  );
  assert.ok(initUi > 0, 'the bootstrap must still initialize the UI');
  assert.ok(
    initialRestore > initUi,
    'the advertised dataset state must be restored after the UI owns its controls'
  );
});

test('the render DOM inventory carries every renderer control', () => {
  for (const id of [
    'hp-shader-quality',
    'hp-lod-enabled',
    'hp-lod-force',
    'hp-frustum-culling',
    'hp-antialias',
    'hp-antialias-status',
    'lod-force-container',
    'hp-lod-force-label',
  ]) {
    assert.ok(
      domCacheSource.includes(`byId('${id}')`),
      `the DOM cache must resolve #${id} for the render controls`
    );
    assert.ok(
      indexHtml.includes(`id="${id}"`),
      `index.html must carry #${id}`
    );
  }
});

test('the markup the renderer controls are validated against still holds', () => {
  // `initRenderControls` refuses to start on markup it does not recognize, so a
  // change here would fail the whole UI at runtime rather than in this suite.
  assert.match(
    indexHtml,
    /<input id="hp-lod-force" type="range" min="-1" max="17" step="1" value="-1"/,
    'the forced-LOD slider must keep its exact -1..17 contract'
  );
  const shaderQuality = indexHtml.slice(
    indexHtml.indexOf('<select id="hp-shader-quality"'),
    indexHtml.indexOf('</select>', indexHtml.indexOf('<select id="hp-shader-quality"'))
  );
  assert.match(
    shaderQuality,
    /<option value="full"/,
    'the first shader-quality option must be the renderer default "full"'
  );
  for (const value of ['full', 'light', 'ultralight']) {
    assert.ok(
      shaderQuality.includes(`value="${value}"`),
      `the shader-quality selector must offer "${value}"`
    );
  }
  assert.equal(
    (shaderQuality.match(/<option /g) ?? []).length,
    3,
    'the shader-quality selector must offer exactly the three the viewer accepts'
  );
});
