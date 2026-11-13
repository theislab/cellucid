/**
 * Browser specs wait for the product's state, never for a fixed time.
 *
 * A spec that pauses a set time for work it cannot see (a redraw, a read, a
 * notification, a toggle event) passes where that work is quick and fails
 * where it is not: a hosted runner draws a frame of software GL in seconds.
 * Such a spec fails on a different engine and
 * shard from run to run and teaches nothing but to re-run it, which slows
 * every change and every upgrade. So a spec waits for what proves the work
 * happened: a locator's state, `expect.poll` on the state the product
 * publishes, an event or a promise the product exposes. Where a spec checks
 * that something does *not* happen, it first waits for what ends the work
 * that could do it, then asserts.
 *
 * `findFixedWaits` (`tests/helpers/fixed-waits.mjs`) finds every
 * `page.waitForTimeout(…)` and every promise a timer resolves in
 * `tests/browser/` (specs, helpers, and the page code they carry). Each one
 * must be listed below, by file and source line:
 *
 * - `ALLOWED_FIXED_WAITS`, with its kind and the reason, when its length is
 *   not standing in for a state:
 *   - `time`: time is the subject (an observation window that proves
 *     nothing is drawn, a debounce or auto-hide countdown, a press held past
 *     a threshold, a simulated slow link, a page timer ordered after the
 *     product's own by its deadline);
 *   - `poll`: the interval of a loop that asks the product's state again
 *     until it holds and fails at its deadline, so the interval sets only
 *     how soon the loop notices, never what it concludes;
 *   - `deadline`: a bound on waiting for an event, whose expiry fails the
 *     test.
 * - `PENDING_RACE_FIXES`, with the fix, while a race-covering sleep awaits
 *   its replacement by a wait on the product's state. This list only
 *   shrinks: a new sleep is never added to it, and the `todo` test below
 *   reports it until it is empty.
 *
 * A wait the scan does not count: a timer of no delay (a turn of the event
 * loop, an ordering step) and a timer that rejects (a deadline that fails).
 * `npm run test:browser:repeat` runs specs many times in every engine to
 * show a race before CI does (`scripts/run-browser-specs-repeat.mjs`).
 */

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { findFixedWaits } from './helpers/fixed-waits.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BROWSER_TESTS = path.join(REPOSITORY_ROOT, 'tests', 'browser');
const KINDS = new Set(['time', 'poll', 'deadline']);

/**
 * Fixed waits whose length is the point. `source` is the trimmed line the
 * wait starts on; `count` is how many waits in the file have that line.
 */
const ALLOWED_FIXED_WAITS = Object.freeze([
  {
    file: 'tests/browser/helpers/control-walk.mjs',
    source: 'new Promise(resolve => { bound = setTimeout(() => resolve(null), quiet); }),',
    count: 1,
    kind: 'time',
    reason: 'A walk that has already stalled reads the page once to say whether the page itself stood still; the read is given as long as the stall lasted, so a page that never answers cannot hold back the report of the stall.',
  },
  {
    file: 'tests/browser/analysis-no-long-tasks.spec.mjs',
    source: 'const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));',
    count: 1,
    kind: 'time',
    reason: 'The unattached page\'s `sleep` is the 50 ms interval of `until`, which throws at its deadline, and the quiet window over which no draw call may be made (as `sceneQuietness` counts them).',
  },
  {
    file: 'tests/browser/backdrop-looks.spec.mjs',
    source: 'await new Promise(resolve => setTimeout(resolve, 1000));',
    count: 1,
    kind: 'time',
    reason: 'Counts look passes over one second to prove ambient motion is paced to at most 30 Hz.',
  },
  {
    file: 'tests/browser/camera-path-transport-bar.spec.mjs',
    source: 'await page.waitForTimeout(renewAfterMs);',
    count: 1,
    kind: 'time',
    reason: 'The transport bar\'s auto-hide countdown is the subject: activity part-way through it must renew it.',
  },
  {
    file: 'tests/browser/camera-path-transport-bar.spec.mjs',
    source: 'await page.waitForTimeout(STRADDLE_MARGIN_MS * 3);',
    count: 1,
    kind: 'time',
    reason: 'Past the point where the unrenewed countdown would have hidden the bar.',
  },
  {
    file: 'tests/browser/camera-path-transport-bar.spec.mjs',
    source: 'await page.waitForTimeout(TRANSPORT_BAR_HIDE_DELAY_MS + STRADDLE_MARGIN_MS);',
    count: 1,
    kind: 'time',
    reason: 'Past the renewed countdown, after which the bar must hide.',
  },
  {
    file: 'tests/browser/cell-info.spec.mjs',
    source: 'await page.waitForTimeout(100);',
    count: 1,
    kind: 'time',
    reason: 'A release more than 50 ms after the last move hands the camera no inertia; the pause is that input.',
  },
  {
    file: 'tests/browser/cell-info.spec.mjs',
    source: 'milliseconds => new Promise(resolve => setTimeout(() => requestAnimationFrame(() => resolve()), milliseconds)),',
    count: 1,
    kind: 'time',
    reason: '`outlastCardTimer`: a page timer of the card\'s own delay (its rest, a held press), armed after the card\'s, runs after it by deadline order however late a runner fires timers; the frame after it follows the lookup the card\'s timer asked for.',
  },
  {
    file: 'tests/browser/community-annotation-startup-lifecycle.spec.mjs',
    source: 'await page.waitForTimeout(3_000);',
    count: 1,
    kind: 'time',
    reason: 'No role check on a timer of its own (the transport\'s retries are the one policy): the absence of requests past the host\'s named reset is the subject.',
  },
  {
    file: 'tests/browser/community-annotation-startup-lifecycle.spec.mjs',
    source: 'await page.waitForTimeout(400);',
    count: 1,
    kind: 'time',
    reason: 'A role check asked for during a held Pull must not run beside it: after its continuations settle, a window in which a request it wrongly issued would have reached the route.',
  },
  {
    file: 'tests/browser/select-bar.spec.mjs',
    source: 'await page.waitForTimeout(800);',
    count: 1,
    kind: 'time',
    reason: '`nextPress`: past the double-tap time (Chromium counts taps 400 ms apart, a desktop double click 500 ms), so a tap on what took a primary button\'s place is a new press, not the double tap `press-guard.js` drops: time is the subject.',
  },
  {
    file: 'tests/browser/data-source-failure-modes.spec.mjs',
    source: 'await page.waitForTimeout(3_000);',
    count: 1,
    kind: 'time',
    reason: 'No background retry behind a shown notice: the absence of requests over a window is the subject.',
  },
  {
    file: 'tests/browser/gene-sample.spec.mjs',
    source: 'await new Promise(resolve => setTimeout(resolve, Math.max(0, at - performance.now())));',
    count: 1,
    kind: 'time',
    reason: 'A simulated link of set latency and bandwidth.',
  },
  {
    file: 'tests/browser/helpers/frame-scheduling.mjs',
    source: 'await new Promise(resolve => setTimeout(resolve, duration));',
    count: 1,
    kind: 'time',
    reason: '`countDrawsDuring` counts draw calls over an observation window; `sceneQuietness` uses it only once the frame loop reports itself settled.',
  },
  {
    file: 'tests/browser/helpers/unattached-webkit.mjs',
    source: 'timer = setTimeout(() => resolve(`reported nothing within ${timeoutMs} ms`), timeoutMs);',
    count: 1,
    kind: 'deadline',
    reason: 'Bounds the wait for the unattached WebKit page\'s report; its expiry is a failure that names the timeout.',
  },
  {
    file: 'tests/browser/idle-frame-scheduling.spec.mjs',
    source: 'await page.waitForTimeout(250);',
    count: 6,
    kind: 'time',
    reason: 'An observation window after page-wide input in which the viewer must issue no draw call.',
  },
  {
    file: 'tests/browser/held-machine.spec.mjs',
    source: 'if (lateMs > 0) await new Promise(resolve => setTimeout(resolve, lateMs));',
    count: 1,
    kind: 'time',
    reason: 'A host answering late (each answer 370 ms late, as a loaded runner answers itself) is the subject: no plan may follow it.',
  },
  {
    file: 'tests/browser/kept-parts.spec.mjs',
    source: 'await new Promise(resolve => setTimeout(resolve, 1000));',
    count: 1,
    kind: 'time',
    reason: 'A slow host (each answer a second late) is the subject.',
  },
  {
    file: 'tests/browser/notebook-widget-jupyterlab.spec.mjs',
    source: 'await new Promise(resolve => setTimeout(resolve, 250));',
    count: 1,
    kind: 'poll',
    reason: 'The interval between probes of the JupyterLab server the spec starts, which throws at its 90 s deadline.',
  },
  {
    file: 'tests/browser/reduced-motion-camera-path.spec.mjs',
    source: 'await page.waitForTimeout(SAMPLE_INTERVAL_MS);',
    count: 2,
    kind: 'time',
    reason: 'Samples the canvas over a window of wall-clock time to prove reduced motion keeps every sample identical.',
  },
  {
    file: 'tests/browser/renderer-smoke.spec.mjs',
    source: 'await new Promise(resolve => setTimeout(resolve, 40));',
    count: 1,
    kind: 'time',
    reason: 'Procedural smoke time advances with the clock while it animates; the pause is that time.',
  },
  {
    file: 'tests/browser/session-restore-gene-sample.spec.mjs',
    source: 'await new Promise(resolve => setTimeout(resolve, Math.max(0, at - performance.now())));',
    count: 1,
    kind: 'time',
    reason: 'A simulated link of set latency and bandwidth.',
  },
  {
    file: 'tests/browser/studio-background.spec.mjs',
    source: 'await page.waitForTimeout(100);',
    count: 1,
    kind: 'time',
    reason: 'A short press fires the shot; the press length is the input.',
  },
  {
    file: 'tests/browser/style-gate.spec.mjs',
    source: 'await new Promise(resolve => setTimeout(resolve, HELD_MS));',
    count: 1,
    kind: 'time',
    reason: 'A slow link (the stylesheet 2.5 s behind the document) is the subject: nothing of the page may be parsed or started before it arrives.',
  },
  {
    file: 'tests/browser/ui-keyboard-lifecycle.spec.mjs',
    source: 'milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),',
    count: 1,
    kind: 'time',
    reason: '`outlastPageTimers`: a page timer of the product\'s delay, armed after the product\'s own, runs after it by deadline order however late a runner fires timers.',
  },
]);

/**
 * Race-covering sleeps waiting for a wait on the product's state. Only
 * removed from, never added to; the `todo` test reports it while it holds
 * anything.
 */
const PENDING_RACE_FIXES = Object.freeze([
]);

async function browserTestFiles(directory = BROWSER_TESTS) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await browserTestFiles(location));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(location);
  }
  return files.sort();
}

/** Every fixed wait under `tests/browser/`, grouped by file and source line. */
async function fixedWaitGroups() {
  const groups = new Map();
  for (const location of await browserTestFiles()) {
    const file = path.relative(REPOSITORY_ROOT, location).split(path.sep).join('/');
    for (const wait of findFixedWaits(await readFile(location, 'utf8'))) {
      const key = `${file}\n${wait.source}`;
      const group = groups.get(key) ?? { file, source: wait.source, lines: [] };
      group.lines.push(wait.line);
      groups.set(key, group);
    }
  }
  return groups;
}

const listed = [...ALLOWED_FIXED_WAITS, ...PENDING_RACE_FIXES];
const keyOf = entry => `${entry.file}\n${entry.source}`;

test('every fixed wait in a browser spec is listed with its reason or its pending fix', async () => {
  const groups = await fixedWaitGroups();
  const entries = new Map(listed.map(entry => [keyOf(entry), entry]));
  const unlisted = [];
  for (const [key, group] of groups) {
    const entry = entries.get(key);
    if (entry === undefined || entry.count < group.lines.length) {
      unlisted.push(`${group.lines.map(line => `${group.file}:${line}`).join(', ')}: ${group.source}`);
    }
  }
  assert.deepEqual(
    unlisted,
    [],
    'A browser spec waits a fixed time. Wait for the product\'s state instead ' +
      '(a locator, `expect.poll` on what the page publishes, an event or a promise); ' +
      'list it in ALLOWED_FIXED_WAITS only when time itself is the subject.',
  );
});

test('every listed fixed wait is still in its file, as many times as listed', async () => {
  const groups = await fixedWaitGroups();
  const stale = listed
    .filter(entry => groups.get(keyOf(entry))?.lines.length !== entry.count)
    .map(entry => `${entry.file}: ${entry.source} (listed ${entry.count}, found ${groups.get(keyOf(entry))?.lines.length ?? 0})`);
  assert.deepEqual(stale, [], 'Update or remove the entries of waits that changed or went away.');
});

test('each listed wait is listed once, with a kind and a reason or a fix', () => {
  const keys = listed.map(keyOf);
  assert.equal(new Set(keys).size, keys.length, 'A wait is listed twice.');
  for (const entry of listed) {
    assert.ok(Number.isSafeInteger(entry.count) && entry.count > 0, `${entry.file}: count`);
    assert.ok(entry.source.length > 0, `${entry.file}: source`);
  }
  for (const entry of ALLOWED_FIXED_WAITS) {
    assert.ok(KINDS.has(entry.kind), `${entry.file}: kind ${entry.kind}`);
    assert.ok(entry.reason.trim().length > 0, `${entry.file}: reason`);
  }
  for (const entry of PENDING_RACE_FIXES) {
    assert.ok(entry.fix.trim().length > 0, `${entry.file}: fix`);
  }
});

test(
  'no race-covering sleep is pending a fix',
  { todo: PENDING_RACE_FIXES.length > 0 && `${PENDING_RACE_FIXES.length} sleeps await a wait on the product's state` },
  () => {
    assert.equal(
      PENDING_RACE_FIXES.length,
      0,
      'Replace each pending sleep with a wait on the product\'s state, then remove its entry.',
    );
  },
);

test('the scan finds every form of fixed wait and nothing else', () => {
  const found = source => findFixedWaits(source).map(wait => wait.line);
  assert.deepEqual(found('await page.waitForTimeout(500);'), [1]);
  assert.deepEqual(found('await frame.waitForTimeout(\n  delay,\n);'), [1]);
  assert.deepEqual(found('await new Promise(resolve => setTimeout(resolve, 300));'), [1]);
  assert.deepEqual(found('await new Promise(r => window.setTimeout(r, 300));'), [1]);
  assert.deepEqual(found('await new Promise((done, fail) => setTimeout(() => done(1), 300));'), [1]);
  assert.deepEqual(found('await new Promise(function (resolve) { setTimeout(resolve, 300); });'), [1]);
  // A sleep helper the page code of a template literal defines.
  assert.deepEqual(found('const page = `\nconst sleep = ms => new Promise(resolve => setTimeout(resolve, ms));\n`;'), [2]);
  // A timer that resolves the promise it sits in, over several lines.
  assert.deepEqual(found('new Promise(resolve => {\n  const timer = setTimeout(() => {\n    resolve(true);\n  }, 3000);\n});'), [2]);
  // A turn of the event loop, not a length of time.
  assert.deepEqual(found('await new Promise(resolve => setTimeout(resolve, 0));'), []);
  assert.deepEqual(found('await new Promise(resolve => setTimeout(resolve));'), []);
  assert.deepEqual(found('new Promise(resolve => setTimeout(() => requestAnimationFrame(resolve), 0));'), []);
  // A deadline that fails the wait, the test budget, a replaced page timer,
  // and a timer that runs the page's own code.
  assert.deepEqual(found('new Promise((resolve, reject) => { setTimeout(() => reject(new Error(\'late\')), 5000); });'), []);
  assert.deepEqual(found('test.setTimeout(240_000);'), []);
  assert.deepEqual(found('window.setTimeout = (handler, ms) => realSetTimeout(handler, ms);'), []);
  assert.deepEqual(found('setTimeout(() => title.focus(), blurAfterMs);'), []);
  // Comment lines are not code.
  assert.deepEqual(found('// await page.waitForTimeout(500);\n/*\n * page.waitForTimeout(1)\n */'), []);
});
