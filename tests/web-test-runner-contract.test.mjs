/**
 * `npm test` (`scripts/run-web-tests.mjs`) fails a test file that hangs, by
 * name and with the last test it finished, and never one that is slow but
 * finishing tests: the bound is on progress (`CELLUCID_TEST_STALL_MS`), not on
 * a file's whole time, which would fail files on a runner several times
 * slower than its peers.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** `run-web-tests.mjs` on `files` with the stall bound `stallMs`, outside this run. */
function runWebTests(files, stallMs, timeout) {
  // Not a part of this run (`node --test` marks its files' processes).
  const { NODE_TEST_CONTEXT: _part, ...env } = process.env;
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-web-tests.mjs'), ...files], {
    encoding: 'utf8',
    env: { ...env, CELLUCID_TEST_STALL_MS: String(stallMs) },
    // A guard on this test only: the runner ends by itself, each file finishing
    // or stopped once it has finished no test for `stallMs`. Its SIGTERM has
    // the runner stop its files' process trees before it ends.
    timeout,
  });
}

test('a slow file that keeps finishing tests passes; a hung one is stopped and named; a failing one fails', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cellucid-web-test-runner-'));
  try {
    // The stall clock of a file starts when its process is started, so the
    // time to start one (two Node processes, the network guard, the test
    // module) counts toward its first test. That time is this machine's, now,
    // under this run's load, never assumed: measured here on a file of one
    // empty test, and the bound set well above it.
    const trivial = path.join(dir, 'trivial.test.mjs');
    writeFileSync(trivial, "import test from 'node:test';\ntest('starts', () => {});\n");
    const begun = performance.now();
    const warm = runWebTests([trivial], 300_000);
    const startMs = performance.now() - begun;
    assert.equal(warm.status, 0, `${warm.stdout}\n${warm.stderr}`);
    const stallMs = Math.max(8_000, Math.ceil(6 * startMs));
    const stepMs = Math.ceil(stallMs / 4);

    const slow = path.join(dir, 'slow.test.mjs');
    const hung = path.join(dir, 'hung.test.mjs');
    const failing = path.join(dir, 'failing.test.mjs');
    // Six tests of a quarter of the bound each: one and a half bounds in all,
    // finishing one every quarter of it.
    writeFileSync(slow, `import test from 'node:test';\nfor (let i = 0; i < 6; i++) test(\`step \${i}\`, () => new Promise(resolve => setTimeout(resolve, ${stepMs})));\n`);
    // Hung with the event loop still busy (a timer), as a real hang is: a
    // promise pending on an empty loop is canceled by Node 22 itself
    // ("Promise resolution is still pending but the event loop has already
    // resolved"), not hung.
    writeFileSync(hung, "import test from 'node:test';\ntest('finishes', () => {});\ntest('never settles', () => new Promise(() => { setInterval(() => {}, 1000); }));\n");
    writeFileSync(failing, "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fails', () => assert.equal(1, 2));\n");
    const run = runWebTests([slow, hung, failing], stallMs, 10 * stallMs);
    const output = `${run.stdout}\n${run.stderr}`;
    assert.equal(run.signal, null, `the runner ended by itself (bound ${stallMs} ms, a start took ${Math.round(startMs)} ms):\n${output}`);
    assert.equal(run.status, 1, output);
    assert.match(output, /^# ok .*slow\.test\.mjs$/m, output);
    assert.match(output, /hung\.test\.mjs: no test finished for \d+ s, so it was stopped; the last finished: finishes/, output);
    assert.match(output, /^# not ok .*failing\.test\.mjs$/m, output);
    assert.match(output, /✖ failing files:\n✖ .*failing\.test\.mjs\n✖ .*hung\.test\.mjs/, output);
    assert.match(output, /ℹ files 3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
