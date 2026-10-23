/**
 * The analytics schema stays inside GA4's limits, admits no free text, and is
 * exactly what the code sends - no undeclared event, no declared-but-dead one.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  EVENTS,
  FEATURES,
  GA4_CUSTOM_DEFINITIONS,
  GA4_LIMITS,
  LOAD_METHODS,
  RESERVED_EVENT_NAMES,
  USER_PROPERTIES,
  countBucket,
  describeError,
  dimensionsDescriptor,
  durationBucket,
  metricRating,
  validateEvent,
  validateUserProperties,
} from '../assets/js/analytics/schema.js';
import { DATA_LOAD_METHODS } from '../assets/js/app/data-load-methods.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS_ROOT = path.join(ROOT, 'assets', 'js');
const read = relative => readFile(path.join(ROOT, relative), 'utf8');
const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

/** Values a real session could produce and that must never be accepted. */
const PII_SHAPED = Object.freeze([
  '/Users/alice/data/AML_relapse_donor7.h5ad',
  'C:\\Users\\alice\\cohort.zarr.zip',
  'alice.smith@uni-example.de',
  'https://alice:ghp_secret@github.com/lab/private',
  'http://10.1.2.3:8765/?token=abc',
  'AML relapse donor 7',
  'Failed to fetch https://lab.example/data/patient7.h5ad',
  'x'.repeat(101),
]);

async function listModules(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return listModules(full);
    return entry.name.endsWith('.js') ? [full] : [];
  }));
  return nested.flat();
}

test('every declared name and value is within GA4 limits', () => {
  for (const [name, definition] of Object.entries(EVENTS)) {
    assert.match(name, SNAKE_CASE);
    assert.ok(name.length <= GA4_LIMITS.eventNameLength, name);
    assert.equal(RESERVED_EVENT_NAMES.has(name), false, name);
    assert.doesNotMatch(name, /^(google_|ga_|firebase_)/);
    const params = Object.keys(definition.params);
    assert.ok(params.length <= GA4_LIMITS.paramsPerEvent, name);
    for (const required of definition.required) {
      assert.ok(params.includes(required), `${name}.${required}`);
    }
    for (const [paramName, type] of Object.entries(definition.params)) {
      assert.match(paramName, SNAKE_CASE);
      assert.ok(paramName.length <= GA4_LIMITS.paramNameLength, paramName);
      if (type.kind === 'enum') {
        for (const value of type.values) {
          assert.ok(value.length <= GA4_LIMITS.paramValueLength, value);
        }
      }
    }
  }
  const userProperties = Object.entries(USER_PROPERTIES);
  assert.ok(userProperties.length <= GA4_LIMITS.userProperties);
  for (const [name, values] of userProperties) {
    assert.match(name, SNAKE_CASE);
    assert.ok(name.length <= GA4_LIMITS.userPropertyNameLength, name);
    for (const value of values) {
      assert.ok(value.length <= GA4_LIMITS.userPropertyValueLength, value);
    }
  }
  for (const [feature, variants] of Object.entries(FEATURES)) {
    assert.match(feature, SNAKE_CASE);
    for (const variant of variants ?? []) {
      assert.ok(variant.length <= GA4_LIMITS.paramValueLength);
    }
  }
});

test('no string parameter accepts a path, an email, a URL or free text', () => {
  const base = {
    data_load: {
      load_method: 'dataset-dropdown',
      source_type: 'local-demo',
      outcome: 'failure',
      duration_ms: 1,
      duration_bucket: '<1s',
    },
    startup_failure: {
      startup_phase: 'catalog',
      source_type: 'remote',
      error_code: 'none',
      error_name: 'Error',
    },
    feature_used: { feature: 'filter', variant: 'category' },
    web_vital: {
      metric_name: 'LCP',
      metric_value: 1,
      navigation_type: 'navigate',
    },
    app_ready: { startup_ms: 1, startup_bucket: '<1s', has_dataset: 0 },
  };
  for (const [eventName, definition] of Object.entries(EVENTS)) {
    assert.doesNotThrow(() => validateEvent(eventName, base[eventName]));
    for (const paramName of Object.keys(definition.params)) {
      for (const value of PII_SHAPED) {
        assert.throws(
          () => validateEvent(eventName, { ...base[eventName], [paramName]: value }),
          { name: 'AnalyticsSchemaError' },
          `${eventName}.${paramName} accepted ${JSON.stringify(value)}`
        );
      }
    }
  }
  for (const name of Object.keys(USER_PROPERTIES)) {
    for (const value of PII_SHAPED) {
      assert.throws(() => validateUserProperties({ [name]: value }));
    }
  }
});

test('the validator refuses undeclared, reserved and malformed payloads whole', () => {
  const cases = [
    ['ui_button_click', { control_id: 'session:save' }],
    ['session_start', {}],
    ['google_event', {}],
    ['data_load', { load_method: 'dataset-dropdown' }],
    ['feature_used', { feature: 'analysis' }],
    ['feature_used', { feature: 'analysis', variant: 'quick' }],
    ['feature_used', { feature: 'figure_export', variant: 'png' }],
    ['feature_used', { feature: 'benchmark', dataset_name: 'x' }],
    ['web_vital', { metric_name: 'FID', metric_value: 1, navigation_type: 'navigate' }],
    ['web_vital', { metric_name: 'LCP', metric_value: Number.NaN, navigation_type: 'navigate' }],
    ['app_ready', { startup_ms: 1.5, startup_bucket: '<1s', has_dataset: 0 }],
    ['app_ready', { startup_ms: 1, startup_bucket: '<1s', has_dataset: 2 }],
  ];
  for (const [name, params] of cases) {
    assert.throws(() => validateEvent(name, params), { name: 'AnalyticsSchemaError' }, name);
  }
  assert.deepEqual(
    validateEvent('feature_used', { feature: 'benchmark', variant: undefined }),
    { feature: 'benchmark' }
  );
});

test('descriptors map raw measurements onto declared enums', () => {
  assert.equal(durationBucket(999), '<1s');
  assert.equal(durationBucket(119_999), '30-120s');
  assert.equal(durationBucket(10 ** 9), '120s+');
  assert.equal(countBucket(999), '<1k');
  assert.equal(countBucket(1_000), '1k-10k');
  assert.equal(countBucket(20_000_000), '10M+');
  // `embeddings.defaults` has one key per dimension the dataset shows,
  // however many embeddings each dimension carries.
  assert.equal(
    dimensionsDescriptor({ '3d': 'X_umap_3d', '2d': 'X_umap' }),
    '2+3'
  );
  assert.equal(
    dimensionsDescriptor({ '1d': 'X_dpt', '2d': 'X_umap', '3d': 'X_umap_3d' }),
    '1+2+3'
  );
  assert.equal(dimensionsDescriptor({ '2d': 'X_pca' }), '2');
  assert.equal(dimensionsDescriptor({ '4d': 'X_umap_4d' }), undefined);
  assert.equal(dimensionsDescriptor({}), undefined);
  assert.equal(dimensionsDescriptor(null), undefined);
  // An array of dimensions is not a defaults object.
  assert.equal(dimensionsDescriptor([3, 2, 2]), undefined);
  assert.equal(metricRating('LCP', 2500), 'good');
  assert.equal(metricRating('CLS', 0.3), 'poor');
  assert.equal(metricRating('LONGTASK_MAX', 400), undefined);
  assert.deepEqual(
    describeError(Object.assign(new TypeError('/Users/alice'), { code: 'X' })),
    { error_code: 'other', error_name: 'TypeError', http_status: undefined }
  );
  assert.deepEqual(describeError('a thrown string'), {
    error_code: 'none',
    error_name: 'other',
    http_status: undefined,
  });
});

test('every parameter is listed for registration in the GA4 admin exactly once', () => {
  const registered = [
    ...GA4_CUSTOM_DEFINITIONS.eventDimensions,
    ...GA4_CUSTOM_DEFINITIONS.eventMetrics.map(metric => metric.name),
    ...GA4_CUSTOM_DEFINITIONS.eventFlagDimensions,
  ];
  assert.equal(new Set(registered).size, registered.length);
  const declared = new Set(
    Object.values(EVENTS).flatMap(definition => Object.keys(definition.params))
  );
  assert.deepEqual([...declared].sort(), [...registered].sort());
  assert.deepEqual(
    [...GA4_CUSTOM_DEFINITIONS.userDimensions].sort(),
    Object.keys(USER_PROPERTIES).sort()
  );
});

test('every load method is reachable from a current load path', async () => {
  assert.deepEqual([...LOAD_METHODS].sort(), Object.values(DATA_LOAD_METHODS).sort());
  const sources = await Promise.all(
    (await listModules(JS_ROOT))
      .filter(file => !file.endsWith(`${path.sep}data-load-methods.js`))
      .map(file => readFile(file, 'utf8'))
  );
  const all = sources.join('\n');
  for (const key of Object.keys(DATA_LOAD_METHODS)) {
    assert.match(all, new RegExp(`DATA_LOAD_METHODS\\.${key}\\b`), key);
  }
});

test('the schema covers every call site, and every declared event has one', async () => {
  const modules = await listModules(JS_ROOT);
  const gtagCallers = [];
  for (const file of modules) {
    const source = await readFile(file, 'utf8');
    if (/\bwindow\.gtag\(/.test(source)) gtagCallers.push(path.relative(JS_ROOT, file));
  }
  // The bootstrap configures, the code-load watch reports the one failure the
  // module graph cannot, and the tracker delivers everything else.
  assert.deepEqual(gtagCallers.sort(), [
    path.join('analytics', 'tracker.js'),
    path.join('app', 'ui', 'core', 'code-load-watch.js'),
    path.join('app', 'ui', 'core', 'ga-init.js'),
  ].sort());

  const tracker = await read('assets/js/analytics/tracker.js');
  const sent = [...tracker.matchAll(/\bsend\('([a-z_]+)'/g)].map(match => match[1]);
  const watch = await read('assets/js/app/ui/core/code-load-watch.js');
  const watched = [...watch.matchAll(/gtag\('event', '([a-z_]+)'/g)].map(match => match[1]);
  assert.deepEqual(
    [...new Set([...sent, ...watched])].sort(),
    Object.keys(EVENTS).sort()
  );

  // Every feature tuple the tracker maps a control to is declared, and every
  // declared feature and variant is reachable from some control.
  // A variant read from the control (`el.value`, or the representation
  // picker's option group, `dimension`) is admitted only after the tracker
  // checks it against FEATURES, so it reaches every declared value.
  const tuples = [...tracker.matchAll(/\['([a-z_]+)'(?:, (?:'([a-z0-9_]+)'|`layout_\$\{el\.value\}`|el\.value|dimension|smokeSupported === false \? 'smoke_unsupported' : 'smoke'))?\]/g)];
  const reachable = new Set();
  for (const [text, feature, variant] of tuples) {
    assert.ok(Object.hasOwn(FEATURES, feature), text);
    if (variant !== undefined) {
      assert.ok(FEATURES[feature]?.includes(variant), text);
      reachable.add(`${feature}:${variant}`);
    } else if (/el\.value|layout_|smoke_unsupported|, dimension\]/.test(text)) {
      if (text.endsWith(', dimension]')) {
        assert.match(
          tracker,
          new RegExp(`FEATURES\\.${feature}\\.includes\\(dimension\\) \\? \\['${feature}', dimension\\]`),
          `${text} must be guarded by its declared variants`
        );
      }
      for (const value of FEATURES[feature]) reachable.add(`${feature}:${value}`);
    } else {
      assert.equal(FEATURES[feature], null, text);
      reachable.add(`${feature}:`);
    }
  }
  for (const [feature, variants] of Object.entries(FEATURES)) {
    for (const variant of variants ?? ['']) {
      assert.ok(reachable.has(`${feature}:${variant}`), `${feature}:${variant}`);
    }
  }

  // Every control the tracker listens for exists: element ids in the page or
  // built with that literal id, declared attributes set by their owners.
  const html = await read('index.html');
  const generated = (await Promise.all(modules.map(file => readFile(file, 'utf8')))).join('\n');
  const block = name => {
    const start = tracker.indexOf(`const ${name} = Object.freeze({`);
    assert.ok(start >= 0, name);
    const body = tracker.slice(start, tracker.indexOf('\n});', start));
    return [...body.matchAll(/^ {2}'([^']+)':/gm)].map(match => match[1]);
  };
  const ids = [...block('CLICK_CONTROLS'), ...block('CHANGE_CONTROLS')];
  assert.ok(ids.length > 20);
  for (const id of ids) {
    const present =
      html.includes(`id="${id}"`) ||
      generated.includes(`id: '${id}'`) ||
      (id.startsWith('analysis-header-') &&
        generated.includes('id="analysis-header-${mode}"') &&
        generated.includes(`mode: '${id.slice('analysis-header-'.length)}',`));
    assert.ok(present, `tracked control #${id} does not exist`);
  }
  for (const declared of block('DECLARED_CONTROLS')) {
    assert.ok(
      generated.includes(`dataset.analyticsId = '${declared}'`),
      `no control declares data-analytics-id ${declared}`
    );
  }
  for (const action of block('ANNOTATION_ACTIONS')) {
    assert.ok(
      generated.includes(`'data-community-annotation-action': '${action}'`),
      `no control declares annotation action ${action}`
    );
  }
});

test('the code-load watch reports one schema-valid failure, only on production', async () => {
  const source = await read('assets/js/app/ui/core/code-load-watch.js');
  const run = (enabled, search) => {
    const calls = [];
    let listener = null;
    class HTMLScriptElement {}
    const script = Object.assign(new HTMLScriptElement(), {
      type: 'module',
      src: 'https://www.cellucid.com/assets/js/app/main.js',
    });
    const root = { dataset: {} };
    const context = vm.createContext({
      HTMLScriptElement,
      URL,
      URLSearchParams,
      location: { origin: 'https://www.cellucid.com' },
      document: {
        baseURI: 'https://www.cellucid.com/',
        documentElement: root,
        getElementById: () => null,
      },
      window: {
        cellucidAnalyticsEnabled: enabled,
        location: { search },
        gtag: (...args) => calls.push(args),
        addEventListener: (_type, handler) => { listener = handler; },
      },
    });
    vm.runInContext(source, context);
    listener({ target: script });
    listener({ target: script });
    return calls;
  };
  const production = run(true, '?remote=http%3A%2F%2F10.1.2.3&dataset=x');
  assert.equal(production.length, 1);
  const [[command, name, params]] = production;
  assert.equal(command, 'event');
  // Copied out of the vm realm, whose objects have their own prototype.
  assert.deepEqual(validateEvent(name, JSON.parse(JSON.stringify(params))), {
    startup_phase: 'code-load',
    source_type: 'remote',
    error_code: 'CODE_LOAD_FAILED',
    error_name: 'Error',
  });
  assert.deepEqual(run(false, ''), []);
});
