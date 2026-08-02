/**
 * Antialiasing is a user setting, and it is the one render setting that cannot
 * take effect while the page is open (CEL-0213).
 *
 * `antialias` is a WebGL context-creation attribute. `rendering/viewer.js` fixes
 * it in its single `getContext('webgl2', …)` call and nothing can change it
 * afterwards; Cellucid has no live context-rebuild path by design, because a
 * lost context is treated as terminal and the user is told to reload. So the
 * setting is a stored preference, read once before the viewer is built, and the
 * control has to say on screen that it applies on the next load. A setting that
 * silently does nothing until reload is worse than one that says so.
 *
 * Three separate things could break that and each is held here:
 *
 *   - the preference could stop reaching the context — `main.js` must read it
 *     and `viewer.js` must request what it is given rather than a literal, and
 *     a stored value neither form matches must be discarded and reported rather
 *     than failing every load with no way back;
 *   - the control could stop reaching the preference — a restored session
 *     publishes by dispatching the control's own event, so `render-controls.js`
 *     must own a listener that exists before the bootstrap restores anything
 *     (the CEL-0129 shape), and a click before that listener exists must not be
 *     accepted (the CEL-0121 shape);
 *   - the control could stop telling the truth — the pending notice must track
 *     the viewer's own context attribute, and a browser that refuses
 *     multisampling must be reported as a refusal rather than as a pending
 *     reload that would never resolve.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ANTIALIAS_STORAGE_KEY,
  DEFAULT_ANTIALIASING,
  resolveAntialiasPreference,
  writeAntialiasPreference,
} from '../assets/js/app/ui/core/antialias-preference.js';
import {
  DEFERRED_CONTROL_IDS,
} from '../assets/js/app/ui/core/deferred-control-readiness.js';
import { createUiControlSerializer } from '../assets/js/app/state-serializer/ui-controls.js';
import { initRenderControls } from '../assets/js/app/ui/modules/render-controls.js';

const MAIN_URL = new URL('../assets/js/app/main.js', import.meta.url);
const VIEWER_URL = new URL('../assets/js/rendering/viewer.js', import.meta.url);
const DOM_CACHE_URL = new URL(
  '../assets/js/app/ui/core/dom-cache.js',
  import.meta.url
);
const INDEX_URL = new URL('../index.html', import.meta.url);

const [mainSource, viewerSource, domCacheSource, indexHtml] = await Promise.all([
  readFile(MAIN_URL, 'utf8'),
  readFile(VIEWER_URL, 'utf8'),
  readFile(DOM_CACHE_URL, 'utf8'),
  readFile(INDEX_URL, 'utf8'),
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

test('nothing stored means antialiasing is on', () => {
  assert.equal(DEFAULT_ANTIALIASING, true);
  assert.deepEqual(
    resolveAntialiasPreference(makeStorage()),
    { enabled: true, discarded: null }
  );
});

test('the two stored forms read back exactly', () => {
  assert.deepEqual(
    resolveAntialiasPreference(makeStorage({ [ANTIALIAS_STORAGE_KEY]: 'on' })),
    { enabled: true, discarded: null }
  );
  assert.deepEqual(
    resolveAntialiasPreference(makeStorage({ [ANTIALIAS_STORAGE_KEY]: 'off' })),
    { enabled: false, discarded: null }
  );
});

test('a stored value in neither form is discarded and handed back', () => {
  // Obeying it is impossible and refusing to start is worse: the app is the
  // only writer of this key, a half-finished write is enough to produce a bad
  // one, and a startup that fails identically on every reload has no way out
  // from inside the app. `github-auth-session` makes the same call for a
  // corrupt stored session. The value comes back so the caller can report it.
  const storage = makeStorage({ [ANTIALIAS_STORAGE_KEY]: 'true' });
  assert.deepEqual(
    resolveAntialiasPreference(storage),
    { enabled: DEFAULT_ANTIALIASING, discarded: 'true' }
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
    { enabled: DEFAULT_ANTIALIASING, discarded: null }
  );
});

test('a bad value that cannot be removed is still reported and still starts', () => {
  const storage = makeStorage({ [ANTIALIAS_STORAGE_KEY]: 'true' });
  storage.failRemoves = new Error('The operation is insecure.');
  assert.deepEqual(
    resolveAntialiasPreference(storage),
    { enabled: DEFAULT_ANTIALIASING, discarded: 'true' }
  );
});

test('the preference round-trips in both directions', () => {
  const storage = makeStorage();
  writeAntialiasPreference(storage, false);
  assert.equal(storage.getItem(ANTIALIAS_STORAGE_KEY), 'off');
  assert.equal(resolveAntialiasPreference(storage).enabled, false);
  writeAntialiasPreference(storage, true);
  assert.equal(storage.getItem(ANTIALIAS_STORAGE_KEY), 'on');
  assert.equal(resolveAntialiasPreference(storage).enabled, true);
});

test('the preference refuses a non-boolean and a storage that is not one', () => {
  assert.throws(
    () => writeAntialiasPreference(makeStorage(), 'off'),
    /exact boolean/
  );
  assert.throws(
    () => resolveAntialiasPreference(null),
    /current key\/value storage/
  );
  assert.throws(
    () => writeAntialiasPreference({ getItem: () => null }, true),
    /current key\/value storage/
  );
});

// ---------------------------------------------------------------------------
// The preference reaches the context
// ---------------------------------------------------------------------------

test('the viewer requests the antialiasing it is given, not a literal', () => {
  // A GL context cannot be created here, so this is a source contract. It is
  // the only thing standing between the setting and a hardcoded attribute
  // quietly returning.
  assert.ok(
    !viewerSource.includes('antialias: true'),
    'viewer.js must not hardcode the antialias attribute'
  );
  assert.match(
    viewerSource,
    /getContext\('webgl2', \{ antialias, powerPreference/,
    'the context must be created with the caller’s antialias value'
  );
  assert.match(
    viewerSource,
    /Viewer creation requires an exact antialias boolean/,
    'createViewer must refuse a missing or non-boolean antialias'
  );
});

test('the bootstrap reads the stored preference before building the viewer', () => {
  const read = mainSource.indexOf('resolveAntialiasPreference(localStorage)');
  const create = mainSource.indexOf('createViewer({');
  assert.ok(read > 0, 'main.js must read the stored antialiasing preference');
  assert.ok(create > 0, 'main.js must still create the viewer');
  assert.ok(
    read < create,
    'the preference must be resolved before the context is created'
  );
  assert.match(
    mainSource,
    /antialias: antialiasPreference\.enabled/,
    'the resolved preference must be what the context is created with'
  );
  assert.equal(
    (mainSource.match(/resolveAntialiasPreference\(/g) ?? []).length,
    1,
    'exactly one place may read the preference'
  );
});

test('a discarded preference is reported to the user, not swallowed', () => {
  const report = mainSource.indexOf('antialiasPreference.discarded !== null');
  const init = mainSource.indexOf('notifications.init();');
  assert.ok(report > 0, 'main.js must report a discarded preference');
  assert.ok(
    report > init,
    'the report must come after the notification centre exists'
  );
});

test('both antialiasing accessors survive context loss and disposal', () => {
  // The panel stays on screen after a context loss, and the overlay tells the
  // user to reload — which is exactly when this control is still useful. A
  // guarded accessor would throw instead of answering.
  const terminalSafe = viewerSource.slice(
    viewerSource.indexOf('const TERMINAL_SAFE_VIEWER_METHODS'),
    viewerSource.indexOf(']);', viewerSource.indexOf('const TERMINAL_SAFE_VIEWER_METHODS'))
  );
  assert.match(terminalSafe, /'getRequestedAntialiasing'/);
  assert.match(terminalSafe, /'getGrantedAntialiasing'/);
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
  } = {}) {
    this.id = id;
    this.tagName = tagName;
    this.type = type;
    this.value = value;
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
  pointSizeInput: ['16.5', '0.5'],
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
  for (const [key, [value, step]] of Object.entries(SLIDER_DEFAULTS)) {
    dom[key] = new FakeElement({ value, min: '0', max: '100', step });
  }
  for (const key of DISPLAY_KEYS) dom[key] = new FakeElement();
  return dom;
}

function makeViewer({ requested = true, granted = requested } = {}) {
  return {
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
    getRequestedAntialiasing: () => requested,
    getGrantedAntialiasing: () => granted,
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

function bootstrap({ requested = true, granted = requested, storage } = {}) {
  const dom = makeDom();
  const viewer = makeViewer({ requested, granted });
  const controls = initRenderControls({
    viewer,
    dom,
    smoke: { rebuildSmokeDensity: () => {} },
  });
  return { dom, viewer, controls, storage };
}

test('the checkbox is seeded from the context, not from the markup', t => {
  // The markup ships `checked`. A user who turned antialiasing off and reloaded
  // must not be shown a ticked box over a canvas that has no antialiasing.
  const storage = makeStorage({ [ANTIALIAS_STORAGE_KEY]: 'off' });
  t.after(installDocument(storage));

  const { dom } = bootstrap({ requested: false, storage });

  assert.equal(dom.hpAntialiasCheckbox.checked, false);
  assert.equal(
    dom.hpAntialiasStatus.textContent,
    '',
    'agreeing with the context in force is not a pending change'
  );
});

test('turning antialiasing off stores it and says when it applies', t => {
  const storage = makeStorage();
  t.after(installDocument(storage));

  const { dom } = bootstrap({ requested: true, storage });
  assert.equal(dom.hpAntialiasStatus.textContent, '');

  dom.hpAntialiasCheckbox.checked = false;
  dom.hpAntialiasCheckbox.dispatchEvent({ type: 'change' });

  assert.equal(storage.getItem(ANTIALIAS_STORAGE_KEY), 'off');
  assert.match(
    dom.hpAntialiasStatus.textContent,
    /Reload the page to apply/,
    'a change that cannot take effect yet must say so'
  );
});

test('changing back to the value in force clears the pending notice', t => {
  const storage = makeStorage();
  t.after(installDocument(storage));

  const { dom } = bootstrap({ requested: true, storage });
  dom.hpAntialiasCheckbox.checked = false;
  dom.hpAntialiasCheckbox.dispatchEvent({ type: 'change' });
  assert.notEqual(dom.hpAntialiasStatus.textContent, '');

  dom.hpAntialiasCheckbox.checked = true;
  dom.hpAntialiasCheckbox.dispatchEvent({ type: 'change' });

  assert.equal(storage.getItem(ANTIALIAS_STORAGE_KEY), 'on');
  assert.equal(
    dom.hpAntialiasStatus.textContent,
    '',
    'nothing is pending once the preference matches the live context again'
  );
});

test('a browser that refuses multisampling is reported as a refusal', t => {
  // `antialias` is a hint. Telling this user to reload would be a lie: the
  // reload would ask again and be refused again.
  const storage = makeStorage();
  t.after(installDocument(storage));

  const { dom } = bootstrap({ requested: true, granted: false, storage });

  assert.match(
    dom.hpAntialiasStatus.textContent,
    /not providing antialiasing/
  );
  assert.doesNotMatch(dom.hpAntialiasStatus.textContent, /Reload/);
});

test('a preference that cannot be stored rolls the control back', t => {
  // Storing is the only effect this control has. Accepting a click that was
  // never recorded would leave the box claiming a setting no reload can deliver.
  const storage = makeStorage();
  t.after(installDocument(storage));

  const { dom } = bootstrap({ requested: true, storage });
  storage.failWrites = new Error('Storage is full.');

  dom.hpAntialiasCheckbox.checked = false;
  dom.hpAntialiasCheckbox.dispatchEvent({ type: 'change' });

  assert.equal(dom.hpAntialiasCheckbox.checked, true, 'the box must roll back');
  assert.equal(storage.getItem(ANTIALIAS_STORAGE_KEY), null);
  assert.equal(dom.hpAntialiasStatus.textContent, '');
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

  // This machine has it on, and the incoming session says off.
  const { dom } = bootstrap({ requested: true, storage });
  storage.setItem(ANTIALIAS_STORAGE_KEY, 'on');
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
    'nothing changed, so there is nothing pending a reload'
  );
});

test('the opposite direction is also left alone', t => {
  // A machine that chose "off" must keep it when a session says "on", which is
  // the direction the user actually hit.
  const storage = makeStorage();
  t.after(installDocument(storage));

  const { dom } = bootstrap({ requested: false, storage });
  storage.setItem(ANTIALIAS_STORAGE_KEY, 'off');
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

  const { dom } = bootstrap({ requested: true, storage });
  dom.hpAntialiasCheckbox.checked = false;

  const serializer = createUiControlSerializer({ sidebar: makeSidebar(dom) });
  const captured = serializer.collectUIControls();

  assert.deepEqual(captured['hp-antialias'], { type: 'checkbox', checked: false });
});

test('restoring the value the control already holds stores nothing new', t => {
  const storage = makeStorage();
  t.after(installDocument(storage));

  const { dom } = bootstrap({ requested: true, storage });
  const serializer = createUiControlSerializer({ sidebar: makeSidebar(dom) });

  serializer.restoreUIControls(savedSession(true));

  assert.equal(storage.getItem(ANTIALIAS_STORAGE_KEY), null);
  assert.equal(dom.hpAntialiasStatus.textContent, '');
});

test('a restore does not depend on storage it never writes', t => {
  // Previously a restore wrote this preference, so a full storage failed the
  // whole session. It writes nothing now, so an unwritable storage is no
  // longer a reason a session cannot be restored.
  const storage = makeStorage();
  t.after(installDocument(storage));

  const { dom } = bootstrap({ requested: true, storage });
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
