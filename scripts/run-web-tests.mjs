import { readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { coreTestFiles } from './test-suites.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDirectory = path.join(repositoryRoot, 'tests');

// `--core`: the core contract tests (`scripts/test-suites.mjs`, `npm run
// test:core`). Else the files named on the command line, else every contract
// test.
const named = process.argv.slice(2);
if (named.includes('--core') && named.length > 1) {
  throw new Error('--core runs the core contract tests and takes no file.');
}
const testFiles = named[0] === '--core'
  ? coreTestFiles()
  : named.length > 0
    ? named.map(file => path.resolve(file))
    : readdirSync(testsDirectory, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
      .map(entry => path.join(testsDirectory, entry.name))
      .sort();

if (testFiles.length === 0) {
  throw new Error(`No web contract tests found in ${testsDirectory}`);
}

// node:test waits forever for a test that never settles (a promise nobody
// resolves once an earlier step failed). A file is stopped, and fails naming
// the last test it finished, only when it has finished no test for this long:
// a machine slower than expected is not a hang. A bound on a file's whole
// time (`--test-timeout`) would fail files on a runner several times slower
// than its peers while every one of them was making progress (measured:
// 38_decisions_testing_and_hosted_runners.md). No contract test takes more
// than seconds on a runner of the usual speed. `CELLUCID_TEST_STALL_MS` sets
// the bound (`tests/web-test-runner-contract.test.mjs`).
const STALL_MS = Number(process.env.CELLUCID_TEST_STALL_MS ?? 300_000);
if (!Number.isFinite(STALL_MS) || STALL_MS <= 0) {
  throw new Error('CELLUCID_TEST_STALL_MS must be a positive number of milliseconds.');
}

// No contract test reaches the network: every request to a host other than
// this machine is refused, and the test file that made it fails, naming it
// (`network-guard-preload.mjs`). Preloaded before `--test`, it runs in every
// test file's process.
const NETWORK_GUARD = pathToFileURL(path.join(repositoryRoot, 'scripts', 'network-guard-preload.mjs')).href;

// As many files at once as `node --test` runs by default.
const PARALLEL = Math.max(1, (os.availableParallelism?.() ?? os.cpus().length) - 1);

const RESULT_LINE = /^\s*(?:not )?ok \d+ - (.*?)(?: # .*)?$/;
const COUNT_LINE = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/;

/** The files' processes still running (`runFile`). */
const running = new Set();

/** Stop `child` and every process it started (a test file's own process under `--test`). */
function stopTree(child) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

// A file's process leads a process group of its own (`detached`, POSIX), and
// the terminal's Ctrl-C and a CI cancellation signal only this process's
// group: without this, an interrupted run would leave every file it had started
// running, a hung one for ever. Each is stopped with its tree before this
// process ends on the signal. (On Windows the files share this console,
// which delivers Ctrl-C to each of them.)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => {
    for (const child of running) stopTree(child);
    process.exit(128 + (os.constants.signals[signal] ?? 0));
  });
}

/**
 * Run one test file under `node --test`, its results read as they come
 * (TAP): `{file, ok, output, counts, stalled}`; `stalled` names the last
 * test it finished when it was stopped for finishing none for `STALL_MS`.
 */
function runFile(file) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--import', NETWORK_GUARD, '--test', '--test-reporter=tap', file], {
      cwd: repositoryRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so a stopped file takes its test process with it.
      detached: process.platform !== 'win32',
    });
    running.add(child);
    // Decoded as streams, so a character split between two chunks (the
    // reporter's "ℹ", any test's name) is never torn into replacement marks.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let output = '';
    let pending = '';
    // A monotonic clock: a wall clock the host steps (NTP on a CI machine
    // that has just booted) would stop a file that is making progress.
    let lastProgress = performance.now();
    let lastTest = null;
    let stalled = null;
    const counts = {};
    child.stdout.on('data', chunk => {
      output += chunk;
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        const result = RESULT_LINE.exec(line);
        if (result) {
          lastProgress = performance.now();
          lastTest = result[1];
        }
        const count = COUNT_LINE.exec(line);
        if (count) counts[count[1]] = Number(count[2]);
      }
    });
    child.stderr.on('data', chunk => {
      output += chunk;
    });
    const watch = setInterval(() => {
      const quiet = performance.now() - lastProgress;
      if (quiet <= STALL_MS) return;
      stalled = { lastTest, seconds: Math.round(quiet / 1000) };
      clearInterval(watch);
      stopTree(child);
    }, Math.min(5_000, Math.max(50, Math.floor(STALL_MS / 4))));
    child.on('error', error => {
      output += `\n# the file's process failed: ${error.message}\n`;
    });
    child.on('close', (code, signal) => {
      running.delete(child);
      clearInterval(watch);
      resolve({ file, ok: stalled === null && code === 0 && signal === null, output, counts, stalled, code, signal });
    });
  });
}

const queue = [...testFiles];
const results = [];
await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    const result = await runFile(file);
    results.push(result);
    const name = path.relative(repositoryRoot, file);
    process.stdout.write(`# ${result.ok ? 'ok' : 'not ok'} ${name}\n${result.output}`);
    if (result.stalled !== null) {
      process.stdout.write(`# ${name}: no test finished for ${result.stalled.seconds} s, so it was stopped; the last finished: ${result.stalled.lastTest ?? 'none'}\n`);
    } else if (!result.ok && result.signal !== null) {
      process.stdout.write(`# ${name}: its process ended on ${result.signal}\n`);
    }
  }
}));

const totals = {};
for (const { counts } of results) {
  for (const [key, value] of Object.entries(counts)) totals[key] = (totals[key] ?? 0) + value;
}
const failed = results.filter(result => !result.ok).map(result => path.relative(repositoryRoot, result.file)).sort();
process.stdout.write(`\nℹ files ${results.length}\n`);
for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
  process.stdout.write(`ℹ ${key} ${totals[key] ?? 0}\n`);
}
if (failed.length > 0) {
  process.stdout.write(`✖ failing files:\n${failed.map(file => `✖ ${file}`).join('\n')}\n`);
}
process.exitCode = failed.length === 0 ? 0 : 1;
