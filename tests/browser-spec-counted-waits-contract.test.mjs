/**
 * A browser spec's wait for a state has no count and no clock of its own.
 *
 * A loop that asks the product's state once a frame (or once a task) and
 * gives up after a number of frames, or at a time it set itself, guesses how
 * fast the machine is. Where a frame takes a second, or a worker builds a
 * tree for longer than the frames beside it, the count runs out first: the
 * live store has not yet adopted its tree order, a frame is read before any
 * pulse frame has been drawn under its rings, a condition that cannot hold
 * costs ten minutes of a test, a sidebar toggle has started no slide. Such a
 * loop runs until its state holds, and the test's timeout is the one fence:
 * it is as patient as the slowest runner and loses nothing on a fast one.
 *
 * This sweeps `tests/browser/` for both shapes:
 * - a `for` loop that counts from 0 to a number, awaits a frame or a timer in
 *   its body, and leaves early (`break`, `return`, or a condition in its
 *   header);
 * - a loop bounded by a deadline it computed from `performance.now()` or
 *   `Date.now()`.
 * Each one found must be listed in `ALLOWED`, with why its count or clock is
 * not standing in for the state.
 *
 * The same holds for the time an assertion or a wait is given. The suite's
 * own is a minute for an assertion (`playwright.config.mjs`, `expect.timeout`)
 * and the test's timeout for everything else; a spec that gives one less
 * (`{ timeout: 10_000 }`) says how fast the machine must be. Every `timeout:`
 * of less than the suite's minute, and every `…TIMEOUT_MS` constant of less,
 * must be listed in `ALLOWED_SHORT`.
 */

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const BROWSER_TESTS = fileURLToPath(new URL('./browser/', import.meta.url));

/** Loops whose count or clock is the subject, by file and the trimmed line that opens them. */
const ALLOWED = Object.freeze([
  {
    file: 'helpers/control-walk.mjs',
    line: 'for (let round = 0; round < 600; round++) {',
    count: 2,
    reason: 'Each round awaits the product\'s own idle promises and ends when three reads agree; 600 rounds is the report that a page never stood still, not a wait for one state.',
  },
  {
    file: 'history-keyboard-chrome.spec.mjs',
    line: 'for (let round = 0; round < 600; round++) {',
    count: 1,
    reason: 'The same settle as the control walk\'s: rounds of the product\'s idle promises until three reads agree.',
  },
  {
    file: 'notebook-widget-jupyterlab.spec.mjs',
    line: 'while (Date.now() < deadline) {',
    count: 1,
    reason: 'Node waits for a JupyterLab process it started to listen, and fails naming the process\'s output: no page state is waited for, and the process may never start.',
  },
  {
    file: 'startup-defaults.spec.mjs',
    line: 'for (let frame = 0; frame < 8; frame += 1) {',
    count: 1,
    reason: 'Eight frames are sampled, each of them: the series is the subject, and the `return` in it is a callback\'s.',
  },
  {
    file: 'analysis-no-long-tasks.spec.mjs',
    line: 'if (performance.now() > end) throw new Error(what + \' within ${OPENING_TIMEOUT_MS} ms\');',
    count: 1,
    reason: 'An unattached page has no Playwright test timeout over its own script: its `until` names what it was waiting for at the opening\'s own bound.',
  },
]);

/** Timeouts of less than the suite's own, by file and trimmed line. */
const ALLOWED_SHORT = Object.freeze([
  {
    file: 'helpers/control-walk.mjs',
    line: 'const ACTION_TIMEOUT_MS = 5_000;',
    reason: 'The least an action of the control walk waits (`actionTimeout`): it waits `ACTION_FRAMES` of the page\'s frames, as slowly as its last settle measured them, so a slower renderer is given longer; a click that does not land in that time is a covered control, pressed from the keyboard.',
  },
  {
    file: 'notebook-widget-jupyterlab.spec.mjs',
    line: 'const armed = await controls.waitFor({ state: \'attached\', timeout: 5_000 }).then(() => true, () => false);',
    reason: 'A lasso drawn again until it arms, inside JupyterLab\'s output frame, where the app\'s own readiness (`helpers/selection-gesture.mjs`) is not reachable from the page. A known guess, run only where JupyterLab is installed.',
  },
]);
const SUITE_EXPECT_TIMEOUT_MS = 60_000;
// A number alone: `5 * 60_000` is a product, read by a person.
const SHORT_TIMEOUT = /\btimeout:\s*([0-9][0-9_]*)\b(?!\s*\*)|TIMEOUT_MS\s*=\s*([0-9][0-9_]*)\s*;/;

/** The lines of `source` that give a wait less than the suite's minute: [line number, trimmed line]. */
export function findShortTimeouts(source) {
  const found = [];
  source.split('\n').forEach((line, index) => {
    const match = SHORT_TIMEOUT.exec(line);
    if (match === null) return;
    const value = Number((match[1] ?? match[2]).replaceAll('_', ''));
    // 0 is no timeout of its own: the test's is the fence.
    if (value > 0 && value < SUITE_EXPECT_TIMEOUT_MS) found.push([index + 1, line.trim()]);
  });
  return found;
}

async function sources(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'fixtures') found.push(...await sources(file));
    } else if (entry.name.endsWith('.mjs')) {
      found.push(file);
    }
  }
  return found;
}

const COUNTED_HEADER = /^(\s*)for \(\s*let (\w+) = 0;\s*\2 < [0-9_]+\b(.*)$/;
const AWAITS_FRAME_OR_TIMER = /await[^\n]*(requestAnimationFrame|\bframes?\(|nextFrame\(|setTimeout|waitForTimeout)/;
const LEAVES_EARLY = /\b(break|return)\b/;
const OWN_CLOCK = /(performance|Date)\.now\(\)\s*[<>]=?\s*\w*([dD]eadline|\bend\b)|\w*([dD]eadline|\bend\b)\s*[<>]=?\s*(performance|Date)\.now\(\)/;

/** The loops of `source` bounded by a count or by a clock of their own: [line number, trimmed line]. */
export function findCountedWaits(source) {
  const lines = source.split('\n');
  const found = [];
  lines.forEach((line, index) => {
    if (line.includes('.now()') && line.length < 400 && OWN_CLOCK.test(line)) found.push([index + 1, line.trim()]);
    const header = COUNTED_HEADER.exec(line);
    if (header === null) return;
    // A header written over several lines ends at its `) {`.
    let open = index;
    while (open < lines.length && !/\)\s*\{?\s*$/.test(lines[open])) open += 1;
    const head = lines.slice(index, open + 1).join('\n');
    const closing = new RegExp(`^${header[1]}\\}`);
    let end = open + 1;
    while (end < lines.length && !closing.test(lines[end])) end += 1;
    // A loop on one line (`for (…) await x;`) is its own body.
    const body = end === lines.length ? head : lines.slice(open, end + 1).join('\n');
    if (!AWAITS_FRAME_OR_TIMER.test(body)) return;
    if (!LEAVES_EARLY.test(body) && !/&&/.test(head)) return;
    found.push([index + 1, line.trim()]);
  });
  return found;
}

test('the scan finds a counted wait and a clocked one, and leaves a counted series alone', () => {
  const lines = source => findCountedWaits(source).map(([line]) => line);
  assert.deepEqual(lines([
    'for (let attempt = 0; attempt < 600; attempt += 1) {',
    '  if (viewer.getFrameScheduleState().settled) return;',
    '  await frames(1);',
    '}',
  ].join('\n')), [1]);
  assert.deepEqual(lines([
    'for (let i = 0; i < 240 && renderer._liveOrder === null; i++) {',
    '  await frame();',
    '  await new Promise(resolve => requestAnimationFrame(resolve));',
    '}',
  ].join('\n')), [1]);
  assert.deepEqual(lines([
    'const deadline = performance.now() + 10_000;',
    'while (!done() && performance.now() < deadline) await frames();',
  ].join('\n')), [2]);
  // Ninety camera positions, a frame each: the count is what is drawn.
  assert.deepEqual(lines([
    'for (let frameIndex = 0; frameIndex < 90; frameIndex++) {',
    '  viewer.setCameraState(path(frameIndex));',
    '  await new Promise(resolve => requestAnimationFrame(resolve));',
    '}',
  ].join('\n')), []);
  assert.deepEqual(lines('while (!viewer.getFrameScheduleState().settled) await frames(1);'), []);
});

test('no browser spec bounds a wait for a state by a count of frames or a clock of its own', async () => {
  const unlisted = [];
  const seen = new Map();
  for (const file of await sources(BROWSER_TESTS)) {
    const relative = path.relative(BROWSER_TESTS, file).split(path.sep).join('/');
    for (const [number, line] of findCountedWaits(await readFile(file, 'utf8'))) {
      const allowed = ALLOWED.find(entry => entry.file === relative && entry.line === line);
      if (allowed === undefined) {
        unlisted.push(`${relative}:${number}: ${line}`);
        continue;
      }
      seen.set(allowed, (seen.get(allowed) ?? 0) + 1);
    }
  }
  assert.deepEqual(unlisted, [], 'wait until the state holds, with no count and no clock; the test\'s timeout is the fence');
  for (const entry of ALLOWED) {
    assert.equal(typeof entry.reason, 'string');
    assert.ok(entry.reason.length > 40, `${entry.file}: say why the count is not standing in for the state`);
    assert.equal(seen.get(entry) ?? 0, entry.count, `${entry.file}: "${entry.line}" is listed ${entry.count} time(s)`);
  }
});

test('no browser spec gives an assertion or a wait less time than the suite does', async () => {
  assert.deepEqual(findShortTimeouts('await expect(row).toBeVisible({ timeout: 10_000 });').map(([line]) => line), [1]);
  assert.deepEqual(findShortTimeouts('const GESTURE_LANDING_TIMEOUT_MS = 3_000;').map(([line]) => line), [1]);
  assert.deepEqual(findShortTimeouts('await page.waitForFunction(ready, null, { timeout: 0 });\nawait expect(x).toBeVisible({ timeout: 120_000 });'), []);
  const unlisted = [];
  const seen = new Set();
  for (const file of await sources(BROWSER_TESTS)) {
    const relative = path.relative(BROWSER_TESTS, file).split(path.sep).join('/');
    for (const [number, line] of findShortTimeouts(await readFile(file, 'utf8'))) {
      const allowed = ALLOWED_SHORT.find(entry => entry.file === relative && entry.line === line);
      if (allowed === undefined) unlisted.push(`${relative}:${number}: ${line}`);
      else seen.add(allowed);
    }
  }
  assert.deepEqual(unlisted, [], 'leave the time to the suite: an assertion has a minute, a wait the test\'s timeout');
  for (const entry of ALLOWED_SHORT) {
    assert.ok(entry.reason.length > 40, `${entry.file}: say why`);
    assert.ok(seen.has(entry), `${entry.file}: "${entry.line}" is listed and no longer there`);
  }
});
