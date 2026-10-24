import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  STARTUP_STALL_CODE,
  STARTUP_STEP_DEADLINE_MS,
  createStartupPhaseOwner,
} from '../assets/js/app/startup-phase.js';

function fakeRoot() {
  return { dataset: {} };
}

test('a startup step publishes its phase and returns its result', async () => {
  const root = fakeRoot();
  const startup = createStartupPhaseOwner({ root });
  let received = null;
  const result = await startup.step('catalog', 'https://x.test/datasets.json', signal => {
    received = signal;
    return 'listed';
  });
  assert.equal(result, 'listed');
  assert.equal(root.dataset.startupPhase, 'catalog');
  assert.ok(received instanceof AbortSignal);
  assert.equal(received.aborted, false);
  startup.enter('positions');
  assert.equal(root.dataset.startupPhase, 'positions');
  assert.throws(() => startup.enter('loading'), /Unknown startup phase/);
  assert.equal(STARTUP_STEP_DEADLINE_MS, 60_000);
});

test('a request that never answers ends at the deadline naming phase and URL', async () => {
  const root = fakeRoot();
  const startup = createStartupPhaseOwner({ root, deadlineMs: 20 });
  let fetchSignal = null;
  await assert.rejects(
    startup.step('health', 'https://x.test/_cellucid/health', signal => {
      fetchSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }),
    error => {
      assert.equal(error.code, STARTUP_STALL_CODE);
      assert.equal(error.phase, 'health');
      assert.equal(error.target, 'https://x.test/_cellucid/health');
      assert.match(
        error.message,
        /checking the data server: https:\/\/x\.test\/_cellucid\/health did not answer within 0\.02 s/
      );
      return true;
    }
  );
  assert.equal(fetchSignal.aborted, true, 'the stalled request is aborted');
  assert.equal(root.dataset.startupPhase, 'health');
});

test('an operation that ignores its signal is still ended by the deadline', async () => {
  const startup = createStartupPhaseOwner({ root: fakeRoot(), deadlineMs: 20 });
  await assert.rejects(
    startup.step('catalog', 'the sample catalog', () => new Promise(() => {})),
    error => error.code === STARTUP_STALL_CODE && error.phase === 'catalog'
  );
});

test('an ordinary failure is reported as itself, and retire aborts open steps', async () => {
  const startup = createStartupPhaseOwner({ root: fakeRoot() });
  const failure = new Error('catalog answered 404');
  await assert.rejects(
    startup.step('catalog', 'https://x.test/datasets.json', () => {
      throw failure;
    }),
    failure
  );

  let stepSignal = null;
  const pending = startup.step('dataset', 'h5ad://x/', signal => {
    stepSignal = signal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const reason = new Error('startup failed elsewhere');
  await Promise.resolve();
  startup.retire(reason);
  await assert.rejects(pending, reason);
  assert.equal(stepSignal.aborted, true);
});

test('every network await of the bootstrap runs through the startup owner', async () => {
  const main = await readFile(
    new URL('../assets/js/app/main.js', import.meta.url),
    'utf8'
  );
  const bootstrapStart = main.indexOf('(async function bootstrap() {');
  const uiStart = main.indexOf('    ui = initUI({', bootstrapStart);
  assert.ok(bootstrapStart > 0 && uiStart > bootstrapStart);
  const bootstrap = main.slice(bootstrapStart, uiStart);
  for (const bare of [
    /await fetch\(/,
    /await githubAuthSession\./,
    /await jupyterSource\.(?:initialize|listDatasets)\(/,
    /await remoteSource\.(?:connect|listDatasets)\(/,
    /await dataSourceManager\.initialize\(/,
    /await localDemoSource\./,
    /await githubSource\./,
    /await targetSource\./,
    /await healthResponse\./,
    /await loadDatasetGeneration\(/,
  ]) {
    assert.doesNotMatch(bootstrap, bare, `${bare} must be a startup step`);
  }
  // After the interface exists, the startup selection loads through the
  // reload, whose network awaits run as deadline-bound startup steps: the
  // dataset's own metadata and generation as `dataset`, the published
  // default session a sample advertises as `session`. Their stall is rethrown
  // to the startup failure surface instead of becoming a sample-view
  // notification.
  const afterUi = main.slice(uiStart, main.indexOf("startup.enter('ready');", uiStart));
  assert.match(
    afterUi,
    /startupOutcome = await ui\.loadStartupDataset\(startupSelection\);/
  );
  const reload = main.slice(
    main.indexOf('async function reloadActiveDatasetInPlace'),
    main.indexOf('async function clearActiveDatasetInPlace')
  );
  assert.match(
    reload,
    /const stagePhases = isStartupLoad \? startup : RELOAD_STAGE_PHASES;/
  );
  assert.match(
    reload,
    /selectionStage = await stagePhases\.step\(\s*'dataset',/
  );
  assert.match(
    reload,
    /requestStep: isStartupLoad\s*\? \(url, operation\) => startup\.step\('session', url, operation\)/
  );
  assert.match(
    main,
    /if \(classified !== null\) return classified;\n(?:\s+\/\/.*\n)+\s+if \(error\?\.code === STARTUP_STALL_CODE\) throw error;/
  );
  assert.match(main, /startup\.enter\('ui'\);\n    ui = initUI\(\{/);
  // The render loop runs before the startup selection loads, and startup is
  // published ready only once that load has settled.
  const viewerStart = main.indexOf('    viewer.start();\n');
  const startupLoad = main.indexOf(
    'await ui.loadStartupDataset(startupSelection)',
    viewerStart
  );
  const ready = main.indexOf("    startup.enter('ready');", startupLoad);
  assert.ok(viewerStart > 0 && startupLoad > viewerStart && ready > startupLoad);
  assert.match(main, /catch \(thrown\) \{\n    const startupError = normalizeStartupError\(thrown\);\n    startup\.retire\(startupError\);/);
});

test('a step that reports progress stalls only when progress stops, however long it takes', async () => {
  // Opening a linked file reads as much as its first view needs, which grows
  // with the file: steady bytes keep it alive past the deadline.
  const startup = createStartupPhaseOwner({ root: fakeRoot(), deadlineMs: 40 });
  const listeners = new Set();
  const progress = onProgress => {
    listeners.add(onProgress);
    return () => listeners.delete(onProgress);
  };
  const tick = () => new Promise(resolve => setTimeout(resolve, 15));
  const result = await startup.step('catalog', 'zenodo:1', async () => {
    for (let report = 0; report < 8; report += 1) {
      await tick();
      for (const listener of listeners) listener();
    }
    return 'opened';
  }, { progress });
  assert.equal(result, 'opened', '120 ms of work under a 40 ms deadline');
  assert.equal(listeners.size, 0, 'the subscription ends with the step');

  await assert.rejects(
    startup.step('catalog', 'zenodo:2', signal => new Promise((_resolve, reject) => {
      // Progress twice, then silence.
      setTimeout(() => listeners.forEach(listener => listener()), 15);
      setTimeout(() => listeners.forEach(listener => listener()), 30);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), { progress }),
    error => error.code === STARTUP_STALL_CODE && error.target === 'zenodo:2'
  );
  await assert.rejects(
    startup.step('catalog', 'x', () => {}, { progress: 'not a subscription' }),
    /progress source must be a subscription/
  );
});
