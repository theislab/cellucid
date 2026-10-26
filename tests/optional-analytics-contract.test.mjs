/**
 * Usage analytics must never be able to stop the application from starting.
 *
 * EasyPrivacy, which uBlock Origin, Brave, AdGuard and iOS content blockers
 * ship, refuses `/analytics/tracker.js`. While `main.js` and the dataset
 * controls imported it statically, that one refused request made the browser
 * abandon the whole module graph: the app never started and the page reported
 * "Cellucid could not load its code". Analytics is now reachable only through
 * the dynamic import in `app/optional-analytics.js`.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS_ROOT = path.join(ROOT, 'assets', 'js');

async function listModules(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return listModules(full);
    return entry.name.endsWith('.js') ? [full] : [];
  }));
  return files.flat();
}

test('no application module imports the analytics modules statically', async () => {
  const offenders = [];
  for (const file of await listModules(JS_ROOT)) {
    const relative = path.relative(JS_ROOT, file);
    if (relative.startsWith(`analytics${path.sep}`)) continue;
    const source = await readFile(file, 'utf8');
    const staticImport = /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*['"][^'"]*\/analytics\/[^'"]*['"]/;
    if (staticImport.test(source)) offenders.push(relative);
  }
  assert.deepEqual(offenders, []);
});

test('a refused analytics module leaves inert entry points instead of throwing', async () => {
  const source = await readFile(
    path.join(JS_ROOT, 'app', 'optional-analytics.js'),
    'utf8'
  );
  assert.match(source, /import\('\.\.\/analytics\/tracker\.js'\)/);
  assert.match(source, /state = 'absent';/);
});

async function facade(loader) {
  const { createOptionalAnalytics } = await import(
    '../assets/js/app/optional-analytics.js'
  );
  return createOptionalAnalytics(loader);
}

function recordingModules() {
  const loads = [];
  const calls = [];
  return {
    loads,
    calls,
    modules: {
      tracker: {
        initAnalytics: () => calls.push('init'),
        trackDataLoad: load => loads.push(load),
        trackAppReady: () => calls.push('ready'),
        trackStartupFailure: () => calls.push('startup-failure'),
      },
      performance: {
        initPerformanceAnalytics: () => calls.push('performance'),
      },
    },
  };
}

test('calls made before the modules arrive are delivered once, in order', async () => {
  const recording = recordingModules();
  let resolve;
  const analytics = await facade(() => new Promise(r => { resolve = r; }));
  const loading = analytics.load();
  assert.equal(analytics.load(), loading, 'load is idempotent');
  analytics.init();
  const beforeBegin = performance.now();
  const load = analytics.beginDataLoad('default-demo', 'local-demo', {
    fromNavigation: true,
  });
  load.succeed({ datasetId: 'suo', metadata: null, stateStatus: 'ready' });
  load.fail(new Error('late'));
  load.cancel();
  analytics.trackAppReady({ viewer: {}, hasDataset: true });
  assert.deepEqual(recording.calls, []);
  resolve(recording.modules);
  await loading;
  assert.deepEqual(recording.calls, ['init', 'ready']);
  assert.equal(recording.loads.length, 1, 'a handle settles exactly once');
  assert.equal(recording.loads[0].outcome, 'success');
  assert.equal(recording.loads[0].loadMethod, 'default-demo');
  // A startup load is timed from navigation start, not from this call: it
  // lasted at least as long as the page had been open when the load began.
  assert.ok(recording.loads[0].durationMs >= beforeBegin,
    `${recording.loads[0].durationMs} ms, the page open for ${beforeBegin} ms at the load's start`);
});

test('a dataset activation joins the open request of its load method', async () => {
  const recording = recordingModules();
  const analytics = await facade(async () => recording.modules);
  await analytics.load();

  const request = analytics.openDataLoad('local-user-file', 'local-user');
  assert.equal(
    analytics.beginDataLoad('dataset-dropdown', 'local-demo') === request,
    false,
    'a different method starts its own request'
  );
  const activation = analytics.beginDataLoad('local-user-file', 'local-user');
  assert.equal(activation, request);
  activation.fail(new Error('activation failed'));
  request.fail(new Error('reported again by the requester'));

  // A request that fails before any activation is still reported.
  analytics.openDataLoad('remote-connect', 'remote')
    .fail(new Error('unreachable'));
  // A superseded or list-only request sends nothing.
  analytics.openDataLoad('link-connect', 'link').cancel();
  const superseded = analytics.beginDataLoad('dataset-dropdown', 'local-demo');
  superseded.cancel();
  superseded.succeed({ datasetId: null, metadata: null, stateStatus: 'ready' });

  assert.deepEqual(
    recording.loads.map(load => [load.loadMethod, load.outcome]),
    [['local-user-file', 'failure'], ['remote-connect', 'failure']]
  );
  assert.equal(recording.loads[0].error.message, 'activation failed');
});

test('refused modules leave every entry point inert and silent', async () => {
  const analytics = await facade(async () => {
    throw new TypeError('Failed to fetch dynamically imported module');
  });
  const originalInfo = console.info;
  const infos = [];
  console.info = (...args) => infos.push(args);
  try {
    await analytics.load();
  } finally {
    console.info = originalInfo;
  }
  assert.equal(infos.length, 1);
  analytics.init();
  analytics.startPerformance({ dataSourceManager: {} });
  analytics.trackStartupFailure({ phase: 'catalog', error: new Error('x') });
  const load = analytics.openDataLoad('local-user-file', 'local-user');
  load.fail(new Error('x'));
  analytics.beginDataLoad('dataset-dropdown', 'local-demo').succeed({
    datasetId: null,
    metadata: null,
    stateStatus: 'ready',
  });
});
