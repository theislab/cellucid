import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  STARTUP_STALL_CODE,
  STARTUP_STEP_DEADLINE_MS,
  createStartupPhaseOwner,
  onStartupStepDeadline,
} from '../assets/js/app/startup-phase.js';
import { virtualTime } from './helpers/virtual-time.mjs';

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
  const pending = startup.step('dataset', 'anndata://x/', signal => {
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
    /await viewerHostSource\.(?:initialize|listDatasets)\(/,
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
  // On a virtual clock: the progress ticks and the deadline are timers of
  // one clock, so a loaded machine cannot put a tick past the deadline.
  const time = virtualTime();
  const startup = createStartupPhaseOwner({ root: fakeRoot(), deadlineMs: 40, after: time.after });
  const listeners = new Set();
  const progress = onProgress => {
    listeners.add(onProgress);
    return () => listeners.delete(onProgress);
  };
  const tick = () => time.sleep(15);
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
      time.after(15, () => listeners.forEach(listener => listener()));
      time.after(30, () => listeners.forEach(listener => listener()));
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), { progress }),
    error => error.code === STARTUP_STALL_CODE && error.target === 'zenodo:2'
  );
  await assert.rejects(
    startup.step('catalog', 'x', () => {}, { progress: 'not a subscription' }),
    /progress source must be a subscription/
  );
});

test('waiting on the person stops the deadline; it starts over, whole, once the person answered', async () => {
  // A sign-in window left open for minutes is the person's time, not a
  // request's silence (seen: an open failed as "nothing arrived for 60 s"
  // while its owner was still in Google's sign-in window).
  const time = virtualTime();
  const listeners = new Set();
  let waiting = false;
  const personWaits = listener => {
    listeners.add(listener);
    listener(waiting);
    return () => listeners.delete(listener);
  };
  const setWaiting = value => {
    waiting = value;
    for (const listener of listeners) listener(value);
  };
  const startup = createStartupPhaseOwner({ root: fakeRoot(), deadlineMs: 40, after: time.after, personWaits });
  const result = await startup.step('catalog', 'gdrive:1', async () => {
    await time.sleep(30);
    setWaiting(true);
    // Ten deadlines of the person's time.
    await time.sleep(400);
    setWaiting(false);
    // Under one whole deadline after the answer.
    await time.sleep(35);
    return 'opened';
  }, { progress: () => () => {} });
  assert.equal(result, 'opened');
  assert.equal(listeners.size, 0, 'the subscription ends with the step');

  // A step that starts while the person is asked waits for the answer too.
  setWaiting(true);
  const pending = startup.step('catalog', 'gdrive:2', () => new Promise(resolve => time.after(500, () => resolve('signed in'))));
  assert.equal(await pending, 'signed in');
  setWaiting(false);

  // Silence after the answer still stalls, after a whole deadline.
  await assert.rejects(
    startup.step('catalog', 'gdrive:3', signal => new Promise((_resolve, reject) => {
      time.after(10, () => setWaiting(true));
      time.after(100, () => setWaiting(false));
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), { progress: () => () => {}, doing: 'opening the data link' }),
    error => {
      assert.equal(error.code, STARTUP_STALL_CODE);
      assert.match(error.message, /^Startup stalled while opening the data link: nothing arrived from gdrive:3 for 0\.04 s\.$/);
      return true;
    }
  );
  await assert.rejects(startup.step('catalog', 'x', () => {}, { doing: '' }), /names what it does in words/);
});

test('the page waits on the person while a sign-in step, the picker or a choice is open', async () => {
  const { onWaitingOnPerson, whileWaitingOnPerson, isWaitingOnPerson } = await import('../assets/js/utils/person-wait.js');
  const heard = [];
  const stop = onWaitingOnPerson(waiting => heard.push(waiting));
  let answer;
  const first = whileWaitingOnPerson(new Promise(resolve => {
    answer = resolve;
  }));
  const second = whileWaitingOnPerson(Promise.reject(new Error('declined')));
  await assert.rejects(second, /declined/);
  assert.equal(isWaitingOnPerson(), true, 'one wait is still open');
  answer('picked');
  assert.equal(await first, 'picked');
  await Promise.resolve();
  assert.equal(isWaitingOnPerson(), false);
  assert.deepEqual(heard, [false, true, false]);
  stop();
  // Every wait on the person registers: the sign-in steps (Google, Microsoft),
  // Google's picker and an R file's question which object to open.
  const read = path => readFile(new URL(`../assets/js/${path}`, import.meta.url), 'utf8');
  assert.match(await read('data/sources/auth/sign-in.js'), /return whileWaitingOnPerson\(promise\);/);
  assert.match(await read('data/sources/auth/google.js'), /return whileWaitingOnPerson\(new Promise\(\(resolve, reject\) => \{\n\s+const view = new pickerApi\.DocsView/);
  assert.match(await read('data/opening-progress.js'), /choose: \(\{ question, options \}\) => whileWaitingOnPerson\(/);
  // The startup owner listens by default, and a data link's step says what it does.
  assert.match(await read('app/startup-phase.js'), /const personWaits = options\.personWaits \?\? onWaitingOnPerson;/);
  assert.match(await read('app/main.js'), /doing: 'opening the data link'/);
});

test('a running step deadline is announced as the one measure of the wait', async () => {
  // The opening under way stands its own silence measure down while a step
  // deadline runs (`data/opening-progress.js`), so a stall is reported once.
  const heard = [];
  const stop = onStartupStepDeadline(measuring => heard.push(measuring));
  assert.deepEqual(heard, [false], 'the current state is heard at once');

  const startup = createStartupPhaseOwner({ root: fakeRoot() });
  let release = null;
  const answering = startup.step('catalog', 'https://x.test/datasets.json', () => new Promise(resolve => {
    release = resolve;
  }));
  assert.deepEqual(heard, [false, true], 'from the moment the step waits');
  while (release === null) await Promise.resolve();
  release('listed');
  assert.equal(await answering, 'listed');
  assert.deepEqual(heard, [false, true, false]);

  // A step that stalls, and one whose setup fails, both let go.
  const hurried = createStartupPhaseOwner({ root: fakeRoot(), deadlineMs: 20 });
  await assert.rejects(
    hurried.step('health', 'https://x.test/_cellucid/health', () => new Promise(() => {})),
    error => error.code === STARTUP_STALL_CODE
  );
  assert.deepEqual(heard, [false, true, false, true, false]);
  await assert.rejects(startup.step('health', '', () => null), TypeError);
  assert.deepEqual(heard, [false, true, false, true, false], 'a refused step never measured');

  // Steps that overlap are announced as one measure.
  const releases = [];
  const first = startup.step('catalog', 'https://x.test/a', () => new Promise(resolve => releases.push(resolve)));
  const second = startup.step('session', 'https://x.test/b', () => new Promise(resolve => releases.push(resolve)));
  while (releases.length < 2) await Promise.resolve();
  assert.deepEqual(heard.slice(5), [true]);
  releases[0]();
  await first;
  assert.deepEqual(heard.slice(5), [true], 'still measured by the other step');
  releases[1]();
  await second;
  assert.deepEqual(heard.slice(5), [true, false]);
  stop();
});
