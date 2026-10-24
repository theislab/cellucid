import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDirectory = path.join(repositoryRoot, 'tests');
// Every file goes on one command line, and Windows caps a command line at
// 32,767 characters. Paths relative to the repository root (the child's
// working directory) keep each entry to its name, so the checkout's location
// does not count once per file.
const testFiles = readdirSync(testsDirectory, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map(entry => path.join('tests', entry.name))
  .sort();

if (testFiles.length === 0) {
  throw new Error(`No web contract tests found in ${testsDirectory}`);
}

// node:test waits forever for a test that never settles (a promise nobody
// resolves once an earlier step failed). Every contract test finishes in
// seconds, so one still running after this long has hung: it fails with a
// timeout and the run goes on, instead of blocking the suite for hours.
const TEST_TIMEOUT_MS = 120_000;

const result = spawnSync(process.execPath, ['--test', `--test-timeout=${TEST_TIMEOUT_MS}`, ...testFiles], {
  cwd: repositoryRoot,
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}
if (result.signal !== null) {
  throw new Error(`Web contract test process terminated by signal ${result.signal}`);
}
if (!Number.isInteger(result.status)) {
  throw new Error('Web contract test process did not publish an integer exit status');
}

process.exitCode = result.status;
