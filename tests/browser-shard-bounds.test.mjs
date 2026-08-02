import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MAX_BROWSER_PROCESSES_PER_SHARD,
  MAX_FILES_PER_BROWSER_PROCESS,
  extractBoundedShardFiles,
  parseBoundedShardArguments,
  partitionBrowserShardFiles,
  planBrowserBatchPorts,
} from '../scripts/run-browser-shard-bounded.mjs';

test('bounded browser shard arguments accept both CLI forms exactly once', () => {
  assert.deepEqual(
    parseBoundedShardArguments(['--project=firefox', '--shard', '2/3']),
    { project: 'firefox', shard: '2/3', headed: false },
  );
  assert.deepEqual(
    parseBoundedShardArguments([
      '--headed',
      '--project',
      'firefox',
      '--shard=1/2',
    ]),
    { project: 'firefox', shard: '1/2', headed: true },
  );
  assert.throws(
    () => parseBoundedShardArguments([
      '--project=firefox',
      '--project',
      'webkit',
      '--shard=1/2',
    ]),
    /--project may be supplied once/,
  );
  assert.throws(
    () => parseBoundedShardArguments(['--project=firefox', '--shard=3/2']),
    /cannot exceed denominator/,
  );
  assert.throws(
    () => parseBoundedShardArguments([
      '--project=firefox',
      '--shard=999999999999999999999/999999999999999999999',
    ]),
    /safe positive integers/,
  );
  assert.throws(
    () => parseBoundedShardArguments(['--project=firefox', '--retry=1']),
    /Unknown bounded browser-shard option/,
  );
  assert.throws(
    () => parseBoundedShardArguments([
      '--project=firefox',
      '--shard=1/2',
      '--headed',
      '--headed',
    ]),
    /--headed may be supplied once/,
  );
});

test('bounded shard discovery preserves a unique repository-local file inventory', () => {
  const testDirectory = fileURLToPath(new URL('./browser/', import.meta.url));
  const absoluteAlpha = fileURLToPath(
    new URL('./browser/alpha.spec.mjs', import.meta.url),
  );
  const report = {
    config: {
      projects: [{ name: 'firefox', testDir: testDirectory }],
    },
    errors: [],
    suites: [
      { file: 'alpha.spec.mjs', suites: [] },
      {
        file: 'nested/beta.spec.mjs',
        suites: [{ file: 'nested/beta.spec.mjs', suites: [] }],
      },
      { file: absoluteAlpha, suites: [] },
    ],
  };

  assert.deepEqual(extractBoundedShardFiles(report, 'firefox'), [
    'tests/browser/alpha.spec.mjs',
    'tests/browser/nested/beta.spec.mjs',
  ]);
  assert.throws(
    () => extractBoundedShardFiles({ ...report, errors: [{}] }, 'firefox'),
    /reported 1 error/,
  );
  assert.throws(
    () => extractBoundedShardFiles({ ...report, suites: [] }, 'firefox'),
    /assigned no files/,
  );
});

test('browser batches bound both process lifetime and process churn', () => {
  assert.equal(MAX_FILES_PER_BROWSER_PROCESS, 6);
  assert.equal(MAX_BROWSER_PROCESSES_PER_SHARD, 8);

  const files = Array.from(
    { length: 45 },
    (_unused, index) => `tests/browser/file-${index}.spec.mjs`,
  );
  const batches = partitionBrowserShardFiles(files);
  assert.deepEqual(
    batches.map(batch => batch.length),
    [6, 6, 6, 6, 6, 6, 6, 3],
  );
  assert.deepEqual(batches.flat(), files);
  assert.ok(Object.isFrozen(batches));
  assert.ok(batches.every(batch => Object.isFrozen(batch)));

  const capacity =
    MAX_FILES_PER_BROWSER_PROCESS * MAX_BROWSER_PROCESSES_PER_SHARD;
  assert.equal(partitionBrowserShardFiles(
    Array.from({ length: capacity }, (_unused, index) => String(index)),
  ).length, MAX_BROWSER_PROCESSES_PER_SHARD);
  assert.throws(
    () => partitionBrowserShardFiles(
      Array.from({ length: capacity + 1 }, (_unused, index) => String(index)),
    ),
    /increase the CI shard count/,
  );
  assert.throws(() => partitionBrowserShardFiles([]), /non-empty array/);
  assert.throws(
    () => partitionBrowserShardFiles(['duplicate', 'duplicate']),
    /must be unique/,
  );
});

test('bounded processes receive non-overlapping server and evidence ports', () => {
  assert.deepEqual(
    planBrowserBatchPorts({
      CELLUCID_BROWSER_TEST_PORT: '5000',
      CELLUCID_BROWSER_TEST_SAMPLE_PORT: '5001',
    }, 3),
    [
      { port: 5000, samplePort: 5001 },
      { port: 5002, samplePort: 5003 },
      { port: 5004, samplePort: 5005 },
    ],
  );
  assert.deepEqual(
    planBrowserBatchPorts({
      CELLUCID_BROWSER_TEST_PORT: '5057',
      CELLUCID_BROWSER_TEST_SAMPLE_PORT: '5058',
    }, 3),
    [
      { port: 5057, samplePort: 5058 },
      { port: 5063, samplePort: 5064 },
      { port: 5065, samplePort: 5066 },
    ],
    'allocation must cross the Fetch-blocked SIP ports without assigning them',
  );
  assert.deepEqual(
    planBrowserBatchPorts({}, MAX_BROWSER_PROCESSES_PER_SHARD).slice(-2),
    [
      { port: 4185, samplePort: 4186 },
      { port: 4187, samplePort: 4188 },
    ],
    'the default CI range must remain bounded below the ninth process pair',
  );
  assert.throws(
    () => planBrowserBatchPorts({}, MAX_BROWSER_PROCESSES_PER_SHARD + 1),
    /maximum is 8/,
  );
  assert.throws(
    () => planBrowserBatchPorts({
      CELLUCID_BROWSER_TEST_PORT: '65534',
      CELLUCID_BROWSER_TEST_SAMPLE_PORT: '65535',
    }, 2),
    /cannot allocate one valid port pair per batch/,
  );
});
