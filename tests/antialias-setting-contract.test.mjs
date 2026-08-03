/**
 * Antialiasing is a live render setting whose default comes from the dataset
 * (CEL-0213).
 *
 * It was neither of those things. `antialias` is a WebGL context-creation
 * attribute, `rendering/viewer.js` fixed it in its single `getContext` call, and
 * Cellucid has no path to a second context — so the setting was a stored
 * preference read once before the viewer existed, and the control told the user
 * it applied on the next load. That was honest about the constraint and wrong
 * about the product: multisampling is the difference between a view that turns
 * and one that does not at millions of cells, costs nothing worth measuring at a
 * few thousand, and datasets are switched in place with no reload, so the right
 * answer changes while the page is open.
 *
 * `rendering/scene-msaa-target.js` moved multisampling into a renderbuffer the
 * application owns and blits, so the drawing buffer is single-sampled and the
 * app owns the switch. Four things are held here:
 *
 *   - the preference has three states, not two, and the third is `auto` — which
 *     is what an absent key means, and what defers to the cell count;
 *   - the viewer must not take antialiasing as a construction argument, and must
 *     not create a multisampled drawing buffer, or the old constraint returns;
 *   - the control must publish to the viewer rather than only to storage, and an
 *     explicit click must end automatic selection in both directions;
 *   - a session must still capture the control and must still not apply it: it
 *     is a device preference, and a shared session must not reach across
 *     machines to turn it off.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ANTIALIAS_MODES,
  ANTIALIAS_STORAGE_KEY,
  AUTOMATIC_ANTIALIAS_CELL_LIMIT,
  DEFAULT_ANTIALIAS_MODE,
  antialiasingInForce,
  automaticAntialiasingForCellCount,
  resolveAntialiasPreference,
  writeAntialiasPreference,
} from '../assets/js/app/ui/core/antialias-preference.js';
import {
  DEFERRED_CONTROL_IDS,
} from '../assets/js/app/ui/core/deferred-control-readiness.js';
import { createUiControlSerializer } from '../assets/js/app/state-serializer/ui-controls.js';
import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { initRenderControls } from '../assets/js/app/ui/modules/render-controls.js';
import {
  POINT_SIZE_SLIDER_MINIMUM,
} from '../assets/js/rendering/point-size-scale.js';

const MAIN_URL = new URL('../assets/js/app/main.js', import.meta.url);
const VIEWER_URL = new URL('../assets/js/rendering/viewer.js', import.meta.url);
const DOM_CACHE_URL = new URL(
  '../assets/js/app/ui/core/dom-cache.js',
  import.meta.url
);
const INDEX_URL = new URL('../index.html', import.meta.url);

const SMOKE_RENDERER_URL = new URL(
  '../assets/js/rendering/smoke-cloud/smoke-renderer.js',
  import.meta.url
);
const COORDINATOR_URL = new URL(
  '../assets/js/app/ui/core/ui-coordinator.js',
  import.meta.url
);

const [
  mainSource,
  viewerSource,
  domCacheSource,
  indexHtml,
  smokeRendererSource,
  coordinatorSource,
] = await Promise.all([
  readFile(MAIN_URL, 'utf8'),
  readFile(VIEWER_URL, 'utf8'),
  readFile(DOM_CACHE_URL, 'utf8'),
  readFile(INDEX_URL, 'utf8'),
  readFile(SMOKE_RENDERER_URL, 'utf8'),
  readFile(COORDINATOR_URL, 'utf8'),
]);

// ---------------------------------------------------------------------------
// The stored preference
// ---------------------------------------------------------------------------

function makeStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    failWrites: null,
    failReads: null,
    failRemoves: null,
    getItem(key) {
      if (this.failReads !== null) throw this.failReads;
      return entries.has(key) ? entries.get(key) : null;
    },
    setItem(key, value) {
      if (this.failWrites !== null) throw this.failWrites;
      entries.set(key, value);
    },
    removeItem(key) {
      if (this.failRemoves !== null) throw this.failRemoves;
      entries.delete(key);
    },
  };
}

test('nothing stored means the dataset decides', () => {
  assert.equal(DEFAULT_ANTIALIAS_MODE, 'auto');
  assert.deepEqual(Array.from(ANTIALIAS_MODES), ['auto', 'on', 'off']);
  assert.deepEqual(
    resolveAntialiasPreference(makeStorage()),
    { mode: 'auto', discarded: null }
  );
});

test('the three stored forms read back exactly', () => {
  for (const mode of ANTIALIAS_MODES) {
    assert.deepEqual(
      resolveAntialiasPreference(
        makeStorage({ [ANTIALIAS_STORAGE_KEY]: mode })
      ),
      { mode, discarded: null }
    );
  }
});

test('a stored value in none of the forms is discarded and handed back', () => {
  // Obeying it is impossible and refusing to start is worse: the app is the
  // only writer of this key, a half-finished write is enough to produce a bad
  // one, and a startup that fails identically on every reload has no way out
  // from inside the app. `github-auth-session` makes the same call for a
  // corrupt stored session. The value comes back so the caller can report it.
  const storage = makeStorage({ [ANTIALIAS_STORAGE_KEY]: 'true' });
  assert.deepEqual(
    resolveAntialiasPreference(storage),
    { mode: DEFAULT_ANTIALIAS_MODE, discarded: 'true' }
  );
  assert.equal(
    storage.getItem(ANTIALIAS_STORAGE_KEY),
    null,
    'the unusable value must not be left behind to fail again'
  );
});

test('a storage that cannot be read starts on the default and reports nothing', () => {
  // A sandboxed frame or blocked third-party storage. Nothing was chosen there,
  // so there is nothing to tell the user about.
  const storage = makeStorage();
  storage.failReads = new Error('The operation is insecure.');
  assert.deepEqual(
    resolveAntialiasPreference(storage),
    { mode: DEFAULT_ANTIALIAS_MODE, discarded: null }
  );
});

test('a bad value that cannot be removed is still reported and still starts', () => {
  const storage = makeStorage({ [ANTIALIAS_STORAGE_KEY]: 'true' });
  storage.failRemoves = new Error('The operation is insecure.');
  assert.deepEqual(
    resolveAntialiasPreference(storage),
    { mode: DEFAULT_ANTIALIAS_MODE, discarded: 'true' }
  );
});

test('the preference round-trips in every direction', () => {
  const storage = makeStorage();
  for (const mode of ANTIALIAS_MODES) {
    writeAntialiasPreference(storage, mode);
    assert.equal(storage.getItem(ANTIALIAS_STORAGE_KEY), mode);
    assert.equal(resolveAntialiasPreference(storage).mode, mode);
  }
});

test('the preference refuses an unknown mode and a storage that is not one', () => {
  assert.throws(
    () => writeAntialiasPreference(makeStorage(), true),
    /exactly "auto", "on", or "off"/
  );
  assert.throws(
    () => resolveAntialiasPreference(null),
    /current key\/value storage/
  );
  assert.throws(
    () => writeAntialiasPreference({ getItem: () => null }, 'on'),
    /current key\/value storage/
  );
});

test('the automatic answer turns over at five million cells', () => {
  // Multisampling multiplies the cost of every covered pixel, and a cloud this
  // large covers nearly every pixel it is drawn over.
  assert.equal(AUTOMATIC_ANTIALIAS_CELL_LIMIT, 5_000_000);
  assert.equal(automaticAntialiasingForCellCount(1), true);
  assert.equal(automaticAntialiasingForCellCount(561_947), true);
  assert.equal(
    automaticAntialiasingForCellCount(AUTOMATIC_ANTIALIAS_CELL_LIMIT - 1),
    true
  );
  assert.equal(
    automaticAntialiasingForCellCount(AUTOMATIC_ANTIALIAS_CELL_LIMIT),
    false,
    'the limit itself is at or above, so it is off'
  );
  assert.equal(automaticAntialiasingForCellCount(18_142_044), false);
  assert.throws(
    () => automaticAntialiasingForCellCount(0),
    /positive safe integer cell count/
  );
});

test('an explicit choice outranks the dataset, in both directions', () => {
  // A user who ticks the box on an eighteen-million-cell dataset means it, and a
  // user who unticks it on a small one means that too.
  assert.equal(antialiasingInForce('on', 18_142_044), true);
  assert.equal(antialiasingInForce('off', 3_696), false);
  assert.equal(antialiasingInForce('auto', 3_696), true);
  assert.equal(antialiasingInForce('auto', 18_142_044), false);
  // No dataset: nothing to measure and nothing on screen to smooth.
  assert.equal(antialiasingInForce('auto', null), true);
  assert.throws(() => antialiasingInForce('maybe', 1), /exactly "auto"/);
});

// ---------------------------------------------------------------------------
// The preference reaches the context
// ---------------------------------------------------------------------------

test('the drawing buffer is single-sampled and owns no antialias attribute', () => {
  // A GL context cannot be created here, so this is a source contract, and it is
  // the only thing standing between the live setting and the constraint it
  // replaced quietly returning.
  assert.match(
    viewerSource,
    /getContext\('webgl2', \{\s*antialias: false,/,
    'the drawing buffer must be single-sampled'
  );
  assert.ok(
    !viewerSource.includes('antialias: true'),
    'a multisampled drawing buffer cannot be switched off again'
  );
  assert.ok(
    !/createViewer\(\{[^}]*\bantialias\b/s.test(viewerSource),
    'createViewer must not take antialiasing as a construction argument'
  );
  assert.match(
    viewerSource,
    /createSceneMsaaTarget\(gl\)/,
    'multisampling must come from the target the application owns'
  );
});

test('the scene target is bound for the frame and resolved in a finally', () => {
  // Four places in the frame body clear and draw, and three of them return
  // early. Binding at each would be four chances to miss one; resolving outside
  // a `finally` would leave a thrown pane showing the frame before it.
  const render = viewerSource.slice(
    viewerSource.indexOf('  function render() {'),
    viewerSource.indexOf('  function renderSceneFrame() {')
  );
  assert.match(render, /sceneMsaaTarget\.beginFrame\(/);
  assert.match(render, /try \{[\s\S]*renderSceneFrame\(\);[\s\S]*\} finally \{[\s\S]*sceneMsaaTarget\.resolveFrame\(/);
});

test('nothing mid-frame binds the default framebuffer behind the target', () => {
  // The smoke renderer and the velocity overlay each bind a framebuffer of their
  // own and have to come back to the scene. Coming back to zero would drop
  // everything drawn after them out of the resolved image.
  const smokeSource = smokeRendererSource;
  assert.ok(
    !smokeSource.includes('bindFramebuffer(gl.FRAMEBUFFER, null)'),
    'the smoke renderer must return to the scene, not to the default buffer'
  );
  assert.match(smokeSource, /sceneFramebuffer/);
  assert.match(
    viewerSource,
    /outputFramebuffer: sceneMsaaTarget\.getSceneFramebuffer\(\)/,
    'the overlay context must be given the scene target'
  );
});

test('the bootstrap no longer reads the preference at all', () => {
  // One reader, and it is the control that owns the setting. Reading it in the
  // bootstrap too would be a second answer to the same question, resolved
  // before the cell count that decides it is known.
  assert.equal(
    (mainSource.match(/resolveAntialiasPreference\(/g) ?? []).length,
    0,
    'the bootstrap must not resolve the antialiasing preference'
  );
  assert.ok(
    !/createViewer\(\{[^}]*antialias/s.test(mainSource),
    'the viewer must not be constructed with an antialiasing value'
  );
});

test('the dataset re-decides antialiasing on every publication', () => {
  // Datasets are switched in place, so a page that opened on four thousand cells
  // and now holds eighteen million has to answer for the eighteen million.
  assert.match(
    mainSource,
    /ui\.applyDatasetRenderDefaults\(\s*publication\.stage\.generation\.identity\.stats\.n_cells/,
    'the cell count must reach the render defaults'
  );
  assert.match(
    coordinatorSource,
    /renderControls\.applyDatasetAntialiasing\(cellCount\)/
  );
});

test('the antialiasing accessors survive context loss and disposal', () => {
  // The panel stays on screen after a context loss, and the overlay tells the
  // user to reload — which is exactly when this control is still useful. A
  // guarded accessor would throw instead of answering.
  const terminalSafe = viewerSource.slice(
    viewerSource.indexOf('const TERMINAL_SAFE_VIEWER_METHODS'),
    viewerSource.indexOf(']);', viewerSource.indexOf('const TERMINAL_SAFE_VIEWER_METHODS'))
  );
  assert.match(terminalSafe, /'getAntialiasing'/);
  assert.match(terminalSafe, /'isAntialiasingAvailable'/);
  assert.ok(
    !terminalSafe.includes("'setAntialiasing'"),
    'publishing a new value is a mutation and must stay fenced'
  );
});

// ---------------------------------------------------------------------------
// The control, wired through its real owner
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
    this.classList = { toggle: () => {} };
  }

  closest() {
    return null;
  }

  addEventListener(type, listener, options = {}) {
    if (options.signal?.aborted) return;
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
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

function makeDom() {
  const dom = {
    backgroundSelect: new FakeElement({ tagName: 'SELECT', value: 'grid' }),
    renderModeSelect: new FakeElement({ tagName: 'SELECT', value: 'points' }),
    renderModeMaturityTag: new FakeElement({ hidden: true }),
    depthControls: new FakeElement(),
    rendererControls: new FakeElement(),
    pointsControls: new FakeElement(),
    smokeControls: new FakeElement(),
    hpLodEnabledCheckbox: new FakeElement({
      id: 'hp-lod-enabled', type: 'checkbox', checked: false,
    }),
    hpFrustumCullingCheckbox: new FakeElement({
      id: 'hp-frustum-culling', type: 'checkbox', checked: false,
    }),
    hpShaderQualitySelect: new FakeElement({
      id: 'hp-shader-quality', tagName: 'SELECT', value: 'full',
      options: ['full', 'light', 'ultralight'],
    }),
    hpLodForceInput: new FakeElement({
      id: 'hp-lod-force', type: 'range', value: '-1', min: '-1', max: '17', step: '1',
    }),
    hpLodForceContainer: new FakeElement({ id: 'lod-force-container' }),
    hpLodForceDisplay: new FakeElement({ id: 'hp-lod-force-label' }),
    // Ships `checked` in `index.html`, exactly as the browser paints it.
    hpAntialiasCheckbox: new FakeElement({
      id: 'hp-antialias', type: 'checkbox', checked: true,
    }),
    hpAntialiasStatus: new FakeElement({ id: 'hp-antialias-status' }),
  };
  for (const [key, [value, step, min = '0']] of Object.entries(SLIDER_DEFAULTS)) {
    dom[key] = new FakeElement({ value, min, max: '100', step });
  }
  for (const key of DISPLAY_KEYS) dom[key] = new FakeElement();
  return dom;
}

function makeViewer({ available = true } = {}) {
  let antialiasing = false;
  return {
    published: [],
    setBackground: () => {},
    setRenderMode: () => {},
    setPointSize: () => {},
    setLightingStrength: () => {},
    setFogDensity: () => {},
    setSizeAttenuation: () => {},
    setSmokeParams: () => {},
    setCloudResolutionScale: () => {},
    setNoiseTextureResolution: () => {},
    getAdaptiveScaleFactor: () => 1,
    hasSnapshots: () => false,
    setShaderQuality: () => {},
    setAdaptiveLOD: () => {},
    setForceLOD: () => {},
    setFrustumCulling: () => {},
    setAntialiasing(value) {
      this.published.push(value);
      antialiasing = available && value;
      return antialiasing;
    },
    getAntialiasing: () => antialiasing,
    isAntialiasingAvailable: () => available,
  };
}

/** A sidebar holding exactly the controls the session serializer would see. */
function makeSidebar(dom) {
  const controls = [
    dom.hpLodEnabledCheckbox,
    dom.hpFrustumCullingCheckbox,
    dom.hpAntialiasCheckbox,
    dom.hpShaderQualitySelect,
    dom.hpLodForceInput,
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
      // This fixture is the renderer accordion, which holds no pressed-button
      // group. Reporting none is faithful, not a simplification.
      if (selector === '[data-state-serializer-pressed-group]') return [];
      throw new Error(`Unexpected sidebar selector ${selector}`);
    },
  };
}

function installDocument(storage) {
  const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const priorStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: {
      documentElement: { dataset: { viewerBackground: 'grid' } },
      getElementById: () => null,
    },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: storage,
  });
  return () => {
    if (priorDocument === undefined) delete globalThis.document;
    else Object.defineProperty(globalThis, 'document', priorDocument);
    if (priorStorage === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', priorStorage);
  };
}

function bootstrap({ available = true, storage } = {}) {
  const dom = makeDom();
  const viewer = makeViewer({ available });
  const controls = initRenderControls({
    viewer,
    dom,
    smoke: { rebuildSmokeDensity: () => {} },
  });
  return { dom, viewer, controls, storage };
}

test('with nothing stored, the dataset decides and the box says so', t => {
  const storage = makeStorage();
  t.after(installDocument(storage));

  const { dom, controls, viewer } = bootstrap({ storage });

  // No dataset yet: nothing to measure, so the box starts on.
  assert.equal(dom.hpAntialiasCheckbox.checked, true);
  assert.match(dom.hpAntialiasStatus.textContent, /Chosen automatically/);

  // A large dataset turns it off with no reload and without storing anything.
  assert.equal(controls.applyDatasetAntialiasing(18_142_044), false);
  assert.equal(dom.hpAntialiasCheckbox.checked, false);
  assert.match(
    dom.hpAntialiasStatus.textContent,
    new RegExp(`${(18_142_044).toLocaleString()} cells`),
  );
  assert.equal(storage.getItem(ANTIALIAS_STORAGE_KEY), null);

  // Switching in place to a small one turns it back on.
  assert.equal(controls.applyDatasetAntialiasing(3_696), true);
  assert.equal(dom.hpAntialiasCheckbox.checked, true);
  assert.deepEqual(viewer.published, [true, false, true]);
});

test('a stored choice is published and the dataset stops deciding', t => {
  const storage = makeStorage({ [ANTIALIAS_STORAGE_KEY]: 'off' });
  t.after(installDocument(storage));

  const { dom, controls } = bootstrap({ storage });
  assert.equal(dom.hpAntialiasCheckbox.checked, false);
  assert.equal(
    dom.hpAntialiasStatus.textContent,
    '',
    'an explicit choice needs no explanation'
  );

  assert.equal(controls.applyDatasetAntialiasing(3_696), false);
  assert.equal(
    dom.hpAntialiasCheckbox.checked,
    false,
    'a small dataset must not override a choice'
  );
});

test('clicking the box publishes it to the renderer and ends automatic', t => {
  const storage = makeStorage();
  t.after(installDocument(storage));

  const { dom, viewer, controls } = bootstrap({ storage });
  controls.applyDatasetAntialiasing(18_142_044);
  assert.equal(dom.hpAntialiasCheckbox.checked, false);

  dom.hpAntialiasCheckbox.checked = true;
  dom.hpAntialiasCheckbox.dispatchEvent({ type: 'change' });

  assert.equal(storage.getItem(ANTIALIAS_STORAGE_KEY), 'on');
  assert.equal(viewer.getAntialiasing(), true);
  assert.equal(
    dom.hpAntialiasStatus.textContent,
    '',
    'no notice: it is already in force'
  );

  // The dataset no longer gets a vote, in the direction the user chose.
  assert.equal(controls.applyDatasetAntialiasing(18_142_044), true);
  assert.equal(dom.hpAntialiasCheckbox.checked, true);
});

test('a browser that refuses multisampling is reported as a refusal', t => {
  // Telling this user to reload would be a lie: the reload would ask again and
  // be refused again, and no preference changes it.
  const storage = makeStorage();
  t.after(installDocument(storage));

  const { dom } = bootstrap({ available: false, storage });

  assert.equal(dom.hpAntialiasCheckbox.checked, false);
  assert.match(
    dom.hpAntialiasStatus.textContent,
    /not providing antialiasing/
  );
  assert.doesNotMatch(dom.hpAntialiasStatus.textContent, /Reload/);
});

test('a preference that cannot be stored rolls the control and renderer back', t => {
  // The preference and the renderer are published together or not at all: a box
  // that survived a failed write would promise a setting on the next load that
  // was never recorded.
  const storage = makeStorage();
  t.after(installDocument(storage));

  const { dom, viewer } = bootstrap({ storage });
  assert.equal(viewer.getAntialiasing(), true);
  storage.failWrites = new Error('Storage is full.');

  dom.hpAntialiasCheckbox.checked = false;
  dom.hpAntialiasCheckbox.dispatchEvent({ type: 'change' });

  assert.equal(dom.hpAntialiasCheckbox.checked, true, 'the box must roll back');
  assert.equal(viewer.getAntialiasing(), true, 'the renderer must roll back');
  assert.equal(storage.getItem(ANTIALIAS_STORAGE_KEY), null);
});

// ---------------------------------------------------------------------------
// A restored session reaches the preference
// ---------------------------------------------------------------------------

/**
 * A saved session, complete: `restoreUIControls` refuses a payload that does
 * not name every control currently in the sidebar, so a partial one would fail
 * for the wrong reason.
 */
function savedSession(antialiasChecked) {
  return {
    'hp-lod-enabled': { type: 'checkbox', checked: false },
    'hp-frustum-culling': { type: 'checkbox', checked: false },
    'hp-antialias': { type: 'checkbox', checked: antialiasChecked },
    'hp-shader-quality': { type: 'select', value: 'full' },
    'hp-lod-force': { type: 'range', value: '-1' },
  };
}

test('a restored session leaves the antialiasing preference alone', t => {
  // The defect this replaces: a restore dispatched `change`, the owner
  // persisted it, and a session became the last writer of a device preference.
  // Every sample publishes an advertised default state, so turning
  // antialiasing off and reloading re-applied the saved value and stored it -
  // the setting could never stay off, which is what a user sees as "I switched
  // it off, refreshed, and it came back".
  const storage = makeStorage();
  t.after(installDocument(storage));

  // This machine has explicitly chosen on, and the incoming session says off.
  storage.setItem(ANTIALIAS_STORAGE_KEY, 'on');
  const { dom } = bootstrap({ storage });
  const serializer = createUiControlSerializer({ sidebar: makeSidebar(dom) });

  serializer.restoreUIControls(savedSession(false));

  assert.equal(
    dom.hpAntialiasCheckbox.checked,
    true,
    'the box must keep showing what this machine actually drew with'
  );
  assert.equal(
    storage.getItem(ANTIALIAS_STORAGE_KEY),
    'on',
    'a session must not overwrite the preference this machine chose'
  );
  assert.equal(
    dom.hpAntialiasStatus.textContent,
    '',
    'an explicit choice needs no explanation, before or after a restore'
  );
});

test('the opposite direction is also left alone', t => {
  // A machine that chose "off" must keep it when a session says "on", which is
  // the direction the user actually hit.
  const storage = makeStorage();
  t.after(installDocument(storage));

  storage.setItem(ANTIALIAS_STORAGE_KEY, 'off');
  const { dom } = bootstrap({ storage });
  const serializer = createUiControlSerializer({ sidebar: makeSidebar(dom) });

  serializer.restoreUIControls(savedSession(true));

  assert.equal(dom.hpAntialiasCheckbox.checked, false);
  assert.equal(storage.getItem(ANTIALIAS_STORAGE_KEY), 'off');
});

test('the control is captured into a session without being listed anywhere', t => {
  // The inventory is a signal, not a hand-maintained call list: any `input[id]`
  // in the sidebar is captured. That is what stops this control from being the
  // next one someone forgets to add.
  const storage = makeStorage();
  t.after(installDocument(storage));

  storage.setItem(ANTIALIAS_STORAGE_KEY, 'on');
  const { dom } = bootstrap({ storage });
  dom.hpAntialiasCheckbox.checked = false;

  const serializer = createUiControlSerializer({ sidebar: makeSidebar(dom) });
  const captured = serializer.collectUIControls();

  assert.deepEqual(captured['hp-antialias'], { type: 'checkbox', checked: false });
});

test('restoring the value the control already holds stores nothing new', t => {
  const storage = makeStorage();
  t.after(installDocument(storage));

  const { dom } = bootstrap({ storage });
  const serializer = createUiControlSerializer({ sidebar: makeSidebar(dom) });

  serializer.restoreUIControls(savedSession(true));

  assert.equal(storage.getItem(ANTIALIAS_STORAGE_KEY), null);
});

test('a restore does not depend on storage it never writes', t => {
  // Previously a restore wrote this preference, so a full storage failed the
  // whole session. It writes nothing now, so an unwritable storage is no
  // longer a reason a session cannot be restored.
  const storage = makeStorage();
  t.after(installDocument(storage));

  const { dom } = bootstrap({ storage });
  const serializer = createUiControlSerializer({ sidebar: makeSidebar(dom) });
  storage.failWrites = new Error('Storage is full.');

  assert.doesNotThrow(() => serializer.restoreUIControls(savedSession(false)));
  assert.equal(dom.hpAntialiasCheckbox.checked, true);
});

// ---------------------------------------------------------------------------
// The control is not offered before its listener exists
// ---------------------------------------------------------------------------

test('the antialiasing control is deferred like its neighbours', () => {
  assert.ok(
    DEFERRED_CONTROL_IDS.includes('hp-antialias'),
    'a click before the listener attaches would be silently undone by the seed'
  );
  assert.ok(indexHtml.includes('id="hp-antialias"'), 'index.html must carry it');
  const tag = indexHtml.slice(
    indexHtml.lastIndexOf('<', indexHtml.indexOf('id="hp-antialias"')),
    indexHtml.indexOf('>', indexHtml.indexOf('id="hp-antialias"'))
  );
  assert.doesNotMatch(
    tag,
    /\bdisabled\b/,
    'the retirement owns the disabled state'
  );
  assert.match(tag, /\bchecked\b/, 'the markup default must be antialiasing on');
});

test('the render DOM inventory carries the control and its status line', () => {
  for (const id of ['hp-antialias', 'hp-antialias-status']) {
    assert.ok(
      domCacheSource.includes(`byId('${id}')`),
      `the DOM cache must resolve #${id}`
    );
    assert.ok(indexHtml.includes(`id="${id}"`), `index.html must carry #${id}`);
  }
});

test('the control lives outside the block that smoke mode hides', () => {
  // `render-controls.js` sets `#renderer-controls` to display:none in smoke
  // mode. The drawing buffer is multisampled in both modes, so a setting that
  // governs it must not disappear with the LOD controls.
  const rendererControls = indexHtml.indexOf('id="renderer-controls"');
  const antialias = indexHtml.indexOf('id="hp-antialias"');
  const smokeControls = indexHtml.indexOf('id="smoke-controls"');
  assert.ok(rendererControls > 0 && antialias > 0 && smokeControls > 0);
  assert.ok(
    antialias > rendererControls && antialias < smokeControls,
    'the control must sit between the renderer block and the smoke block'
  );
  assert.ok(
    indexHtml.includes('id="antialias-controls"'),
    'the control must have its own block rather than joining #renderer-controls'
  );
});

test('the tooltip states both halves of the trade', () => {
  // A scientific viewer must not present this as a free speed-up. The measured
  // cost in pixels belongs where the user makes the choice.
  const tooltip = indexHtml.slice(
    indexHtml.indexOf('id="antialias-info-tooltip"'),
    indexHtml.indexOf(
      '</div>',
      indexHtml.indexOf('info-tooltip-content', indexHtml.indexOf('id="antialias-info-tooltip"'))
    )
  );
  assert.match(tooltip, /faster/, 'the speed the user gains must be stated');
  assert.match(
    indexHtml.slice(
      indexHtml.indexOf('id="antialias-info-tooltip"'),
      indexHtml.indexOf('id="hp-antialias"')
    ),
    /pixels change/,
    'the picture the user loses must be stated beside it'
  );
});

test('a discarded preference is reported without breaking the controls', t => {
  const storage = makeStorage({ [ANTIALIAS_STORAGE_KEY]: 'true' });
  t.after(installDocument(storage));
  const center = getNotificationCenter();
  const originalWarning = center.warning;
  const warnings = [];
  center.warning = (message, options) => {
    warnings.push([message, options]);
  };
  t.after(() => {
    center.warning = originalWarning;
  });

  const { dom } = bootstrap({ storage });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /"true" was not recognized/);
  assert.equal(warnings[0][1].category, 'rendering');
  assert.equal(
    dom.hpAntialiasCheckbox.checked,
    true,
    'the discarded value must leave the dataset deciding'
  );
});

test('a reporter that throws cannot stop the controls initializing', t => {
  // Discarding rather than throwing exists so a bad stored value cannot break a
  // load. A report that throws would undo exactly that.
  const storage = makeStorage({ [ANTIALIAS_STORAGE_KEY]: 'true' });
  t.after(installDocument(storage));
  const center = getNotificationCenter();
  const originalWarning = center.warning;
  center.warning = () => {
    throw new Error('synthetic notification failure');
  };
  t.after(() => {
    center.warning = originalWarning;
  });

  assert.doesNotThrow(() => bootstrap({ storage }));
});
