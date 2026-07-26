import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDirectory = path.join(repositoryRoot, 'tests');
const testFiles = readdirSync(testsDirectory, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map(entry => path.join(testsDirectory, entry.name))
  .sort();

if (testFiles.length === 0) {
  throw new Error(`No web contract tests found in ${testsDirectory}`);
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
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
