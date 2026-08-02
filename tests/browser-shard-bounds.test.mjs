import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MAX_BROWSER_PROCESSES_PER_SHARD,
  MAX_FILES_PER_BROWSER_PROCESS,
  MAX_ORDINARY_BROWSER_PROCESSES_PER_SHARD,
  MAX_TESTS_PER_BROWSER_PROCESS,
  PROCESS_INTENSIVE_REPORT_TAG,
  extractBoundedShardInventory,
  parseBoundedShardArguments,
  partitionBrowserShardInventory,
  planBrowserBatchPorts,
  shouldIsolateProcessIntensiveFiles,
} from '../scripts/run-browser-shard-bounded.mjs';

const inventoryItem = (file, tests, intensive = false) => ({
  file,
  intensive,
  tests,
});

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
  const spec = (file, projectName = 'firefox', tags = []) => ({
    file,
    tags,
    tests: [{ projectName }],
  });
  const report = {
    config: {
      projects: [{ name: 'firefox', testDir: testDirectory }],
    },
    errors: [],
    suites: [
      {
        specs: [spec(
          'alpha.spec.mjs',
          'firefox',
          [PROCESS_INTENSIVE_REPORT_TAG],
        )],
        suites: [{ specs: [spec(absoluteAlpha)], suites: [] }],
      },
      { specs: [spec('nested/beta.spec.mjs')], suites: [] },
    ],
  };

  const inventory = extractBoundedShardInventory(report, 'firefox');
  assert.deepEqual(inventory, [
    {
      file: 'tests/browser/alpha.spec.mjs',
      intensive: true,
      tests: 2,
    },
    {
      file: 'tests/browser/nested/beta.spec.mjs',
      intensive: false,
      tests: 1,
    },
  ]);
  assert.ok(Object.isFrozen(inventory));
  assert.ok(inventory.every(item => Object.isFrozen(item)));
  assert.throws(
    () => extractBoundedShardInventory({ ...report, errors: [{}] }, 'firefox'),
    /reported 1 error/,
  );
  assert.throws(
    () => extractBoundedShardInventory({ ...report, suites: [] }, 'firefox'),
    /assigned no files/,
  );
  assert.throws(
    () => extractBoundedShardInventory({
      ...report,
      suites: [{ specs: [spec('alpha.spec.mjs', 'chromium')], suites: [] }],
    }, 'firefox'),
    /mixed projects/,
  );
  assert.throws(
    () => extractBoundedShardInventory({
      ...report,
      suites: [{
        specs: [{ ...spec('alpha.spec.mjs'), tags: [42] }],
        suites: [],
      }],
    }, 'firefox'),
    /publish string tags/,
  );
});

test('process-intensive isolation is limited to vulnerable native runtimes', () => {
  assert.equal(
    shouldIsolateProcessIntensiveFiles(
      'firefox',
      { RUNNER_OS: 'macOS' },
      'linux',
    ),
    true,
  );
  assert.equal(
    shouldIsolateProcessIntensiveFiles('firefox', {}, 'darwin'),
    true,
  );
  assert.equal(
    shouldIsolateProcessIntensiveFiles(
      'webkit',
      { RUNNER_OS: 'Linux' },
      'darwin',
    ),
    true,
  );
  assert.equal(
    shouldIsolateProcessIntensiveFiles('webkit', {}, 'linux'),
    true,
  );
  assert.equal(
    shouldIsolateProcessIntensiveFiles(
      'webkit',
      { RUNNER_OS: 'macOS' },
      'linux',
    ),
    false,
  );
  assert.equal(
    shouldIsolateProcessIntensiveFiles(
      'firefox',
      { RUNNER_OS: 'Linux' },
      'linux',
    ),
    false,
  );
  assert.throws(
    () => shouldIsolateProcessIntensiveFiles(
      'webkit',
      { RUNNER_OS: 42 },
      'linux',
    ),
    /RUNNER_OS must be a string/,
  );
});

test('native-GPU stress files declare every test process-intensive', async () => {
  for (const filename of [
    'benchmark-harness.spec.mjs',
    'edge-texture-publication.spec.mjs',
  ]) {
    const source = await readFile(
      new URL(`./browser/${filename}`, import.meta.url),
      'utf8',
    );
    const declarations = source.match(/^test\(/gm) ?? [];
    const intensiveDeclarations = source.match(
      /,\s*PROCESS_INTENSIVE,\s*async\s*\(/g,
    ) ?? [];

    assert.ok(declarations.length > 0, filename);
    assert.equal(intensiveDeclarations.length, declarations.length, filename);
    assert.match(
      source,
      new RegExp(`tag:\\s*['"]@${PROCESS_INTENSIVE_REPORT_TAG}['"]`),
      filename,
    );
  }
});

test('browser batches bound file count, test weight, and process churn', () => {
  assert.equal(MAX_FILES_PER_BROWSER_PROCESS, 6);
  assert.equal(MAX_TESTS_PER_BROWSER_PROCESS, 40);
  assert.equal(MAX_ORDINARY_BROWSER_PROCESSES_PER_SHARD, 8);
  assert.equal(MAX_BROWSER_PROCESSES_PER_SHARD, 9);

  // Exact current largest-shard weights. Its eight process generations remain
  // unchanged while each is now fenced by both file and test count.
  const testCounts = [
    4, 2, 1, 8, 5, 11,
    5, 2, 10, 2, 1, 2,
    4, 3, 4, 1, 2, 2,
    1, 2, 6, 1, 19, 2,
    1, 1, 6, 4, 1, 3,
    1, 3, 1, 1, 6, 3,
    2, 1, 1, 14, 3, 4,
    1, 1, 6,
  ];
  const inventory = testCounts.map((tests, index) => inventoryItem(
    `tests/browser/file-${index}.spec.mjs`,
    tests,
  ));
  const batches = partitionBrowserShardInventory(inventory);
  assert.deepEqual(
    batches.map(batch => batch.files.length),
    [6, 6, 6, 6, 6, 6, 6, 3],
  );
  assert.deepEqual(
    batches.map(batch => batch.testCount),
    [31, 22, 16, 31, 16, 15, 25, 8],
  );
  assert.deepEqual(
    batches.flatMap(batch => batch.files),
    inventory.map(item => item.file),
  );
  assert.ok(Object.isFrozen(batches));
  assert.ok(batches.every(batch => Object.isFrozen(batch)));
  assert.ok(batches.every(batch => Object.isFrozen(batch.files)));

  // Linux WebKit's native GPU process crashed on the first ordinary test after
  // the four intensive edge-publication tests. The tag makes that exact file a
  // complete browser lifetime, while the 45-file shard remains capped at nine
  // processes and every other runtime retains the eight-process plan above.
  const isolatedInventory = inventory.map((item, index) => ({
    ...item,
    intensive: index === 0,
  }));
  const isolatedBatches = partitionBrowserShardInventory(
    isolatedInventory,
    true,
  );
  assert.deepEqual(
    isolatedBatches.map(batch => batch.files.length),
    [1, 6, 6, 6, 6, 6, 6, 6, 2],
  );
  assert.deepEqual(
    isolatedBatches.map(batch => batch.testCount),
    [4, 32, 21, 13, 31, 16, 16, 24, 7],
  );
  assert.deepEqual(isolatedBatches[0].files, [inventory[0].file]);

  // macOS Firefox completed the five benchmark stress tests but retained a
  // degraded GPU process that killed the following runtime-publication page.
  // The benchmark file therefore owns one complete process generation too.
  const shardOneCounts = [
    8, 1, 7, 22, 1, 3,
    1, 2, 1, 5, 2, 12,
    3, 3, 3, 3, 2, 1,
    2, 35, 4, 7, 8, 18,
    4, 4, 4,
  ];
  const isolatedBenchmarkInventory = shardOneCounts.map(
    (tests, index) => inventoryItem(
      `tests/browser/shard-one-${index}.spec.mjs`,
      tests,
      index === 9,
    ),
  );
  const isolatedBenchmarkBatches = partitionBrowserShardInventory(
    isolatedBenchmarkInventory,
    true,
  );
  assert.deepEqual(
    isolatedBenchmarkBatches.map(batch => batch.files.length),
    [5, 4, 1, 6, 4, 4, 3],
  );
  assert.deepEqual(
    isolatedBenchmarkBatches.map(batch => batch.testCount),
    [39, 7, 5, 26, 40, 37, 12],
  );
  assert.deepEqual(
    isolatedBenchmarkBatches[2].files,
    [isolatedBenchmarkInventory[9].file],
  );

  // The hosted Firefox failure came from six legal files that together owned
  // 74 tests. Test weight now divides that exact shape without adding a ninth
  // process or weakening the six-file fence.
  const formerlyOversized = [2, 35, 4, 7, 8, 18].map(
    (tests, index) => inventoryItem(
      `tests/browser/weighted-${index}.spec.mjs`,
      tests,
    ),
  );
  assert.deepEqual(
    partitionBrowserShardInventory(formerlyOversized).map(batch => ({
      files: batch.files.length,
      tests: batch.testCount,
    })),
    [
      { files: 2, tests: 37 },
      { files: 4, tests: 37 },
    ],
  );

  const fileCapacity =
    MAX_FILES_PER_BROWSER_PROCESS *
    MAX_ORDINARY_BROWSER_PROCESSES_PER_SHARD;
  assert.equal(partitionBrowserShardInventory(
    Array.from({ length: fileCapacity }, (_unused, index) => ({
      file: String(index),
      intensive: false,
      tests: 1,
    })),
  ).length, MAX_ORDINARY_BROWSER_PROCESSES_PER_SHARD);
  assert.throws(
    () => partitionBrowserShardInventory(
      Array.from({ length: fileCapacity + 1 }, (_unused, index) => ({
        file: String(index),
        intensive: false,
        tests: 1,
      })),
    ),
    /increase the CI shard count/,
  );
  assert.throws(
    () => partitionBrowserShardInventory([
      inventoryItem(
        'too-large.spec.mjs',
        MAX_TESTS_PER_BROWSER_PROCESS + 1,
      ),
    ]),
    /split the spec file/,
  );
  assert.throws(
    () => partitionBrowserShardInventory(
      Array.from({
        length: MAX_ORDINARY_BROWSER_PROCESSES_PER_SHARD + 1,
      }, (_unused, index) => ({
        file: `weighted-${index}.spec.mjs`,
        intensive: false,
        tests: MAX_TESTS_PER_BROWSER_PROCESS,
      })),
    ),
    /increase the CI shard count/,
  );
  assert.throws(
    () => partitionBrowserShardInventory([]),
    /non-empty array/,
  );
  assert.throws(
    () => partitionBrowserShardInventory([
      inventoryItem('duplicate', 1),
      inventoryItem('duplicate', 1),
    ]),
    /must be unique/,
  );
  assert.throws(
    () => partitionBrowserShardInventory([
      inventoryItem('valid.spec.mjs', 1),
    ], 'yes'),
    /isolation must be a boolean/,
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
      { port: 4187, samplePort: 4188 },
      { port: 4191, samplePort: 4192 },
    ],
    'the default CI range must remain bounded through the ninth process pair',
  );
  assert.throws(
    () => planBrowserBatchPorts({}, MAX_BROWSER_PROCESSES_PER_SHARD + 1),
    /maximum is 9/,
  );
  assert.throws(
    () => planBrowserBatchPorts({
      CELLUCID_BROWSER_TEST_PORT: '65534',
      CELLUCID_BROWSER_TEST_SAMPLE_PORT: '65535',
    }, 2),
    /cannot allocate one valid port pair per batch/,
  );
});
