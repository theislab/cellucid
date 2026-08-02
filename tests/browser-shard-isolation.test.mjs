import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  extractIsolatedShardFiles,
  parseIsolatedShardArguments,
  planIsolatedShardPorts,
} from '../scripts/run-browser-shard-isolated.mjs';

test('isolated browser shard arguments accept both CLI forms exactly once', () => {
  assert.deepEqual(
    parseIsolatedShardArguments(['--project=firefox', '--shard', '2/3']),
    { project: 'firefox', shard: '2/3', headed: false },
  );
  assert.deepEqual(
    parseIsolatedShardArguments([
      '--headed',
      '--project',
      'firefox',
      '--shard=1/2',
    ]),
    { project: 'firefox', shard: '1/2', headed: true },
  );
  assert.throws(
    () => parseIsolatedShardArguments([
      '--project=firefox',
      '--project',
      'webkit',
      '--shard=1/2',
    ]),
    /--project may be supplied once/,
  );
  assert.throws(
    () => parseIsolatedShardArguments(['--project=firefox', '--shard=3/2']),
    /cannot exceed denominator/,
  );
  assert.throws(
    () => parseIsolatedShardArguments([
      '--project=firefox',
      '--shard=999999999999999999999/999999999999999999999',
    ]),
    /safe positive integers/,
  );
  assert.throws(
    () => parseIsolatedShardArguments(['--project=firefox', '--retry=1']),
    /Unknown isolated browser-shard option/,
  );
  assert.throws(
    () => parseIsolatedShardArguments([
      '--project=firefox',
      '--shard=1/2',
      '--headed',
      '--headed',
    ]),
    /--headed may be supplied once/,
  );
});

test('isolated shard discovery preserves a unique repository-local file inventory', () => {
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

  assert.deepEqual(extractIsolatedShardFiles(report, 'firefox'), [
    'tests/browser/alpha.spec.mjs',
    'tests/browser/nested/beta.spec.mjs',
  ]);
  assert.throws(
    () => extractIsolatedShardFiles({ ...report, errors: [{}] }, 'firefox'),
    /reported 1 error/,
  );
  assert.throws(
    () => extractIsolatedShardFiles({ ...report, suites: [] }, 'firefox'),
    /assigned no files/,
  );
});

test('isolated files receive non-overlapping server and evidence ports', () => {
  assert.deepEqual(
    planIsolatedShardPorts({
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
    planIsolatedShardPorts({
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
    planIsolatedShardPorts({}, 10).slice(-2),
    [
      { port: 4191, samplePort: 4192 },
      { port: 4193, samplePort: 4194 },
    ],
    'the default CI range must skip the Fetch-blocked sieve port',
  );
  assert.throws(
    () => planIsolatedShardPorts({
      CELLUCID_BROWSER_TEST_PORT: '65534',
      CELLUCID_BROWSER_TEST_SAMPLE_PORT: '65535',
    }, 2),
    /cannot allocate one valid port pair/,
  );
});
