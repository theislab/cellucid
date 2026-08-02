/**
 * The renderer and benchmark controls are wired only after the linear bootstrap
 * in `main.js` has already blocked on something. `index.html` paints them
 * before any of that, so for the whole of startup they were offered and did
 * nothing (CEL-0121): a click reached no listener, and the renderer toggles
 * additionally seeded their rollback baselines from whatever the user had
 * changed, so the panel could claim a setting the renderer was never told
 * about.
 *
 * These tests hold the three parts of the correction together: the controls
 * named here are the ones actually wired late, they are retired before the
 * first await and admitted only after the last listener, and the benchmark
 * disclosure — which cannot be disabled and opens itself — is reconciled at the
 * moment its listener is attached.
 *
 * The two groups are wired at different points and that difference is
 * load-bearing. The benchmark controls are wired at the very end. The renderer
 * controls belong to `ui/modules/render-controls`, built by `initUI` *before*
 * the bootstrap restores a saved session, because restoring one publishes each
 * control by dispatching its own event and a dispatch with no listener is
 * silently lost (CEL-0129).
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DEFERRED_CONTROL_IDS,
  DEFERRED_CONTROL_SELECTORS,
  retireDeferredControls,
} from '../assets/js/app/ui/core/deferred-control-readiness.js';

const MAIN_URL = new URL('../assets/js/app/main.js', import.meta.url);
const INDEX_URL = new URL('../index.html', import.meta.url);
const RENDER_CONTROLS_URL = new URL(
  '../assets/js/app/ui/modules/render-controls.js',
  import.meta.url
);

const [mainSource, indexHtml, renderControlsSource] = await Promise.all([
  readFile(MAIN_URL, 'utf8'),
  readFile(INDEX_URL, 'utf8'),
  readFile(RENDER_CONTROLS_URL, 'utf8'),
]);

/** The wiring site in `main.js` for every benchmark control. */
const BENCHMARK_WIRING_SITES = Object.freeze({
  'benchmark-run': "benchmarkRunBtn.addEventListener('click'",
  'benchmark-report-btn': "benchmarkReportBtn.addEventListener('click'",
  'bottleneck-analyze-btn': "bottleneckAnalyzeBtn.addEventListener('click'",
  '.benchmark-preset': "btn.addEventListener('click'",
});

/**
 * The wiring site in `render-controls.js` for every renderer control.
 *
 * `hp-antialias` is in this group even though it publishes to storage rather
 * than to the viewer: it is seeded from the viewer's own context attribute when
 * its listener attaches, so a click made before that is visibly undone.
 */
const RENDERER_WIRING_SITES = Object.freeze({
  'hp-shader-quality': "listen(hpShaderQualitySelect, 'change'",
  'hp-frustum-culling': "listen(hpFrustumCullingCheckbox, 'change'",
  'hp-lod-enabled': "listen(hpLodEnabledCheckbox, 'change'",
  'hp-lod-force': "listen(hpLodForceInput, 'input'",
  'hp-antialias': "listen(hpAntialiasCheckbox, 'change'",
});

function createControl(id, { disabled = false } = {}) {
  return { id, disabled };
}

function createDocument({ ids = DEFERRED_CONTROL_IDS, presets = 3 } = {}) {
  const controls = new Map(ids.map(id => [id, createControl(id)]));
  const presetControls = Array.from({ length: presets }, (_unused, index) =>
    createControl(`preset-${index}`)
  );
  return {
    controls,
    presetControls,
    getElementById(id) {
      return controls.get(id) ?? null;
    },
    querySelectorAll(selector) {
      assert.equal(selector, '.benchmark-preset');
      return presetControls;
    },
  };
}

test('every deferred control exists in the interface and is wired late', () => {
  for (const id of DEFERRED_CONTROL_IDS) {
    assert.ok(
      indexHtml.includes(`id="${id}"`),
      `index.html must carry #${id}`
    );
  }
  for (const selector of DEFERRED_CONTROL_SELECTORS) {
    assert.ok(
      indexHtml.includes(`class="btn-small ${selector.slice(1)}"`),
      `index.html must carry ${selector}`
    );
  }

  // None of them may ship `disabled` from markup: the retirement below owns
  // that state, and a control disabled twice would never be admitted back.
  for (const id of DEFERRED_CONTROL_IDS) {
    const tag = indexHtml.slice(
      indexHtml.lastIndexOf('<', indexHtml.indexOf(`id="${id}"`)),
      indexHtml.indexOf('>', indexHtml.indexOf(`id="${id}"`))
    );
    assert.doesNotMatch(
      tag,
      /\bdisabled\b/,
      `#${id} must not also ship disabled from markup`
    );
  }
});

test('retirement happens before the first await and admission after the last listener', () => {
  const retirement = mainSource.indexOf('retireDeferredControls(document)');
  const admission = mainSource.indexOf('admitDeferredControls();');
  assert.ok(retirement > 0, 'main.js must retire the deferred controls');
  assert.ok(admission > retirement, 'main.js must admit them afterwards');

  const firstAwait = mainSource.indexOf('await githubAuthSession');
  assert.ok(firstAwait > 0, 'the first bootstrap await must still be findable');
  assert.ok(
    retirement < firstAwait,
    'controls must be retired before the bootstrap blocks on anything'
  );

  // The last await in the linear bootstrap settles the initial publication.
  // Every benchmark wiring site sits after it, which is the defect this guards.
  const settle = mainSource.indexOf(
    'await settleInitialPublishedDatasetStateOutcome('
  );
  assert.ok(settle > firstAwait, 'the settle await must still be findable');

  for (const [control, site] of Object.entries(BENCHMARK_WIRING_SITES)) {
    const wiring = mainSource.indexOf(site);
    assert.ok(wiring > 0, `${control} must still be wired at ${site}`);
    assert.ok(
      wiring > settle,
      `${control} is wired after the publication settles, so it must be deferred`
    );
    assert.ok(
      wiring < admission,
      `${control} must be wired before the controls are admitted`
    );
  }

  // The renderer controls are wired by `initUI`, which is itself several awaits
  // into the bootstrap — late enough to need deferring, early enough that a
  // restored session still reaches them.
  const initUi = mainSource.indexOf('ui = initUI({');
  assert.ok(initUi > firstAwait, 'initUI must still run after the first await');
  assert.ok(initUi < admission, 'initUI must run before the controls are admitted');
  for (const [control, site] of Object.entries(RENDERER_WIRING_SITES)) {
    assert.ok(
      renderControlsSource.includes(site),
      `${control} must be wired by render-controls at ${site}`
    );
    assert.ok(
      !mainSource.includes(site),
      `${control} must not also be wired by the bootstrap`
    );
  }
});

test('the benchmark disclosure is reconciled where its listener is attached', () => {
  // `<details>` cannot be disabled and the browser opens it with no script
  // involved, so the correction is to read its state when the listener lands.
  const listener = mainSource.indexOf(
    "benchmarkSection.addEventListener(\n        'toggle',"
  );
  const reconcile = mainSource.indexOf(
    'ownBenchmarkPanelSynchronization();\n    }'
  );
  assert.ok(listener > 0, 'the benchmark toggle listener must still exist');
  assert.ok(
    reconcile > listener,
    'the open state must be reconciled after the listener is attached'
  );
  assert.ok(
    !DEFERRED_CONTROL_IDS.includes('benchmark-section'),
    'the disclosure is reconciled, not disabled'
  );
});

test('retirement disables every deferred control and admission restores them', () => {
  const documentOwner = createDocument();
  const admit = retireDeferredControls(documentOwner);

  for (const control of documentOwner.controls.values()) {
    assert.equal(control.disabled, true, `#${control.id} must be retired`);
  }
  for (const control of documentOwner.presetControls) {
    assert.equal(control.disabled, true, `${control.id} must be retired`);
  }

  admit();
  for (const control of documentOwner.controls.values()) {
    assert.equal(control.disabled, false, `#${control.id} must be admitted`);
  }
  for (const control of documentOwner.presetControls) {
    assert.equal(control.disabled, false, `${control.id} must be admitted`);
  }
});

test('admission leaves a control that was already disabled alone', () => {
  const documentOwner = createDocument();
  documentOwner.controls.get('benchmark-run').disabled = true;

  const admit = retireDeferredControls(documentOwner);
  admit();

  assert.equal(
    documentOwner.controls.get('benchmark-run').disabled,
    true,
    'a control disabled by its own owner keeps that state'
  );
  assert.equal(documentOwner.controls.get('hp-lod-enabled').disabled, false);
});

test('admission is idempotent', () => {
  const documentOwner = createDocument();
  const admit = retireDeferredControls(documentOwner);
  admit();
  documentOwner.controls.get('benchmark-run').disabled = true;
  admit();
  assert.equal(
    documentOwner.controls.get('benchmark-run').disabled,
    true,
    'a second admission must not undo a later owner of the control'
  );
});

test('a missing control is named rather than silently skipped', () => {
  assert.throws(
    () =>
      retireDeferredControls(
        createDocument({
          ids: DEFERRED_CONTROL_IDS.filter(id => id !== 'benchmark-run'),
        })
      ),
    /require #benchmark-run/
  );
  assert.throws(
    () => retireDeferredControls(createDocument({ presets: 0 })),
    /require \.benchmark-preset/
  );
});
