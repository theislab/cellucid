/**
 * What the tracker actually hands to `gtag`, driven through its real entry
 * points with a recorded `gtag`.
 *
 * The owner needs the data for development decisions and Google's terms forbid
 * personal data, so every assertion here is about content: a local dataset is
 * described by shape only, an error by its stable code, a control by the id a
 * developer declared. The fixture strings are what a real user would have -
 * a file named after a donor, a category named after a patient, an error
 * message quoting a private path - and none of them may reach a payload.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const CANONICAL_CATALOG = 'https://theislab.github.io/cellucid-datasets/anndata/';
const SENSITIVE = Object.freeze([
  'AML_relapse_donor7', 'patient', 'donor', '/Users/', 'alice', '@',
  'BRCA1', 'secret', '10.1.2.3', 'token',
]);

function installBrowser({ hostEnabled, metaContent = CANONICAL_CATALOG, search = '' }) {
  const listeners = [];
  const calls = [];
  const errors = [];
  globalThis.window = {
    cellucidAnalyticsEnabled: hostEnabled,
    location: { href: `https://www.cellucid.com/${search}`, search },
    innerWidth: 1440,
    matchMedia: query => ({ matches: query === '(any-pointer: fine)' }),
    gtag: (...args) => calls.push(args),
  };
  globalThis.document = {
    addEventListener: (type, handler, options) => {
      listeners.push({ type, handler, options });
    },
    querySelectorAll: selector => (
      selector === 'meta[name="cellucid-sample-catalog"]'
        ? [{ getAttribute: () => metaContent }]
        : []
    ),
  };
  globalThis.reportError = error => errors.push(error);
  return { listeners, calls, errors };
}

function events(calls) {
  return calls.filter(call => call[0] === 'event').map(([, name, params]) => ({
    name,
    params,
  }));
}

function assertNoSensitiveContent(calls) {
  const sent = JSON.stringify(calls);
  for (const fragment of SENSITIVE) {
    assert.equal(
      sent.includes(fragment),
      false,
      `"${fragment}" reached gtag: ${sent}`
    );
  }
}

function element({ id = '', dataset = {}, parent = null, ...rest } = {}) {
  return { id, dataset, parentElement: parent, ...rest };
}

const LOCAL_METADATA = Object.freeze({
  id: 'local-user:h5ad:h5ad_AML_relapse_donor7',
  name: 'AML_relapse_donor7',
  stats: {
    n_cells: 48_213,
    n_genes: 31_000,
    n_obs_fields: 14,
    has_connectivity: false,
  },
  embeddings: {
    default_dimension: 3,
    defaults: { '2d': 'X_umap', '3d': 'X_umap_3d' },
    items: {
      X_pca: {
        label: 'X_pca',
        dimension: 2,
        path: 'obsm/0/0-1',
        source: { key: 'X_pca', columns: [0, 1] },
      },
      X_umap: {
        label: 'X_umap',
        dimension: 2,
        path: 'obsm/1/0-1',
        source: { key: 'X_umap', columns: [0, 1] },
      },
      X_umap_3d: {
        label: 'X_umap_3d',
        dimension: 3,
        path: 'obsm/2/0-1-2',
        source: { key: 'X_umap_3d', columns: [0, 1, 2] },
      },
    },
  },
});

// DATA_CONFIG is computed once, when data-source.js first evaluates, from the
// page this installs: no `sampleCatalog` query, the canonical meta element.
installBrowser({ hostEnabled: true });
const tracker = await import('../assets/js/analytics/tracker.js');

test('a production page sends environment classes, then only declared events', () => {
  const { listeners, calls, errors } = installBrowser({ hostEnabled: true });
  tracker.initAnalytics();
  assert.deepEqual(calls[0], [
    'set',
    'user_properties',
    { input_class: 'mouse', viewport_class: 'desktop' },
  ]);
  assert.throws(() => tracker.initAnalytics(), /initialized twice/);
  assert.deepEqual(
    listeners.map(({ type, options }) => [type, options.capture]),
    [['click', true], ['change', true]]
  );
  const click = listeners.find(entry => entry.type === 'click').handler;
  const change = listeners.find(entry => entry.type === 'change').handler;

  // A legend button labelled with a patient category: only its declared id
  // counts, and its label is never read.
  const legendButton = element({
    dataset: { analyticsId: 'legend:highlight-category' },
    getAttribute: () => 'Highlight category patient BRCA1',
    textContent: 'patient BRCA1',
  });
  click({ isTrusted: true, target: legendButton });
  click({ isTrusted: true, target: legendButton });
  // An undeclared control is not counted at all.
  click({ isTrusted: true, target: element({ id: 'secret-donor-button' }) });
  // A synthetic event from state restoration is not adoption.
  click({ isTrusted: false, target: element({ id: 'save-state-btn' }) });
  // A click inside a declared control resolves to it.
  click({
    isTrusted: true,
    target: element({ parent: element({ id: 'analysis-header-genesPanel' }) }),
  });
  // The two analyses added beside it are counted by their own variants.
  click({ isTrusted: true, target: element({ id: 'analysis-header-dotplot' }) });
  click({ isTrusted: true, target: element({ id: 'analysis-header-composition' }) });
  // A field select names dataset fields; only the fact of the change counts.
  change({
    isTrusted: true,
    target: element({ id: 'categorical-field', value: 'donor_patient_7' }),
  });
  change({ isTrusted: true, target: element({ id: 'render-mode', value: 'smoke' }) });
  change({ isTrusted: true, target: element({ id: 'navigation-mode', value: 'unknown' }) });

  assert.deepEqual(events(calls), [
    { name: 'feature_used', params: { feature: 'legend_highlight' } },
    { name: 'feature_used', params: { feature: 'analysis', variant: 'genes_panel' } },
    { name: 'feature_used', params: { feature: 'analysis', variant: 'dotplot' } },
    { name: 'feature_used', params: { feature: 'analysis', variant: 'composition' } },
    { name: 'feature_used', params: { feature: 'color_by_category' } },
    { name: 'feature_used', params: { feature: 'render_mode', variant: 'smoke' } },
  ]);
  assertNoSensitiveContent(calls);
  assert.deepEqual(errors, []);
});

test('a local dataset is described by shape only; a public sample keeps its id', () => {
  const { calls, errors } = installBrowser({ hostEnabled: true });
  tracker.trackDataLoad({
    loadMethod: 'local-user-h5ad',
    sourceType: 'local-user',
    outcome: 'success',
    durationMs: 3811.6,
    datasetId: LOCAL_METADATA.id,
    metadata: LOCAL_METADATA,
    stateStatus: 'ready',
  });
  tracker.trackDataLoad({
    loadMethod: 'dataset-dropdown',
    sourceType: 'local-demo',
    outcome: 'success',
    durationMs: 912,
    datasetId: 'suo',
    metadata: { stats: { n_cells: 2_000_000, has_connectivity: true } },
    stateStatus: 'ready-state-restored',
  });
  assert.deepEqual(events(calls), [
    {
      name: 'data_load',
      params: {
        load_method: 'local-user-h5ad',
        source_type: 'local-user',
        outcome: 'success',
        duration_ms: 3812,
        duration_bucket: '3-10s',
        cell_bucket: '10k-100k',
        gene_bucket: '10k-100k',
        field_count: 14,
        dimensions: '2+3',
        has_connectivity: 0,
        has_vector_field: 0,
        state_restore: 'none',
      },
    },
    {
      name: 'data_load',
      params: {
        load_method: 'dataset-dropdown',
        source_type: 'local-demo',
        outcome: 'success',
        duration_ms: 912,
        duration_bucket: '<1s',
        dataset_id: 'suo',
        cell_bucket: '1M-10M',
        has_connectivity: 1,
        has_vector_field: 0,
        state_restore: 'restored',
      },
    },
  ]);
  assertNoSensitiveContent(calls);
  assert.deepEqual(errors, []);
});

test('a failure is reported by stable code, never by its message', () => {
  const { calls } = installBrowser({ hostEnabled: true });
  const cause = Object.assign(
    new Error('Payload /Users/alice/AML_relapse_donor7.h5ad is truncated'),
    { name: 'DataSourceError', code: 'INVALID_FORMAT', details: { status: 404 } }
  );
  tracker.trackDataLoad({
    loadMethod: 'remote-connect',
    sourceType: 'remote',
    outcome: 'failure',
    durationMs: 120,
    datasetId: null,
    metadata: null,
    error: new AggregateError([cause], 'recovery failed for http://10.1.2.3/?token=x'),
  });
  tracker.trackStartupFailure({
    phase: 'health',
    error: Object.assign(new Error('secret http://10.1.2.3'), { code: 'EWHATEVER' }),
  });
  tracker.trackStartupFailure({ phase: 'ui', error: new Error('second') });
  assert.deepEqual(events(calls), [
    {
      name: 'data_load',
      params: {
        load_method: 'remote-connect',
        source_type: 'remote',
        outcome: 'failure',
        duration_ms: 120,
        duration_bucket: '<1s',
        error_code: 'INVALID_FORMAT',
        error_name: 'DataSourceError',
        http_status: 404,
      },
    },
    {
      name: 'startup_failure',
      params: {
        startup_phase: 'health',
        source_type: 'local-demo',
        error_code: 'other',
        error_name: 'Error',
      },
    },
  ]);
  assertNoSensitiveContent(calls);
});

test('a custom catalog keeps its dataset ids out of analytics', async () => {
  installBrowser({ hostEnabled: true, metaContent: 'https://lab.example/private/' });
  const fresh = await import('../assets/js/analytics/tracker.js?catalog=custom');
  const { calls } = installBrowser({
    hostEnabled: true,
    metaContent: 'https://lab.example/private/',
  });
  fresh.initAnalytics();
  fresh.trackDataLoad({
    loadMethod: 'dataset-url-param',
    sourceType: 'local-demo',
    outcome: 'success',
    durationMs: 10,
    datasetId: 'AML_relapse_donor7',
    metadata: null,
    stateStatus: 'ready',
  });
  const [load] = events(calls);
  assert.equal(Object.hasOwn(load.params, 'dataset_id'), false);
  assertNoSensitiveContent(calls);
});

test('off production nothing is sent, but a schema violation is still raised', async () => {
  const offline = await import('../assets/js/analytics/tracker.js?host=localhost');
  const { calls, errors } = installBrowser({ hostEnabled: false });
  offline.initAnalytics();
  offline.trackDataLoad({
    loadMethod: 'not-a-method',
    sourceType: 'local-user',
    outcome: 'success',
    durationMs: 1,
    datasetId: null,
    metadata: null,
    stateStatus: 'ready',
  });
  offline.trackWebVital('LCP', 1200, { navigationType: 'navigate', sourceType: null });
  assert.deepEqual(calls, []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].name, 'AnalyticsSchemaError');
  assert.match(errors[0].message, /load_method/);
});

test('app readiness reports environment classes without the renderer string', async () => {
  const fresh = await import('../assets/js/analytics/tracker.js?ready=1');
  const { calls } = installBrowser({ hostEnabled: true });
  // Chromium masks RENDERER; the class comes from the unmasked string.
  const gl = {
    RENDERER: 1,
    VENDOR: 2,
    // No float blending: smoke is unsupported on this device.
    getExtension: name => (
      name === 'WEBGL_debug_renderer_info'
        ? { UNMASKED_RENDERER_WEBGL: 3, UNMASKED_VENDOR_WEBGL: 4 }
        : name === 'EXT_color_buffer_float' ? {} : null
    ),
    getParameter: parameter => ({
      1: 'WebKit WebGL',
      2: 'WebKit',
      3: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))',
      4: 'Google Inc. (Google)',
    })[parameter],
  };
  globalThis.performance ??= { now: () => 2140 };
  // The viewer's own cached smoke detection is never triggered by analytics.
  const viewer = {
    getSmokeSupport: () => {
      throw new Error('analytics must not run the viewer smoke detection');
    },
    getGLContext: () => gl,
  };
  fresh.trackAppReady({ viewer, hasDataset: true });
  fresh.trackAppReady({ viewer, hasDataset: false });
  assert.deepEqual(calls[0], [
    'set',
    'user_properties',
    { renderer_class: 'software', smoke_supported: 'no' },
  ]);
  const ready = events(calls);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].name, 'app_ready');
  assert.equal(ready[0].params.has_dataset, 1);
  assert.equal(JSON.stringify(calls).includes('SwiftShader'), false);
});

test('off production app readiness never touches the GPU', async () => {
  const fresh = await import('../assets/js/analytics/tracker.js?ready=local');
  const { calls, errors } = installBrowser({ hostEnabled: false });
  fresh.trackAppReady({
    viewer: {
      getSmokeSupport: () => { throw new Error('smoke detection ran'); },
      getGLContext: () => { throw new Error('GPU context read'); },
    },
    hasDataset: true,
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(errors, []);
});
