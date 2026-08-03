import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  HOST_GPU_TERMINAL_REPORT_TAG,
  MAX_BROWSER_PROCESSES_PER_SHARD,
  MAX_FILES_PER_BROWSER_PROCESS,
  MAX_ORDINARY_BROWSER_PROCESSES_PER_SHARD,
  MAX_TESTS_PER_BROWSER_PROCESS,
  PROCESS_INTENSIVE_REPORT_TAG,
  WINDOWS_MAX_BROWSER_PROCESSES_PER_SHARD,
  WINDOWS_MAX_FILES_PER_BROWSER_PROCESS,
  WINDOWS_MAX_TESTS_PER_BROWSER_PROCESS,
  extractBoundedShardInventory,
  parseBoundedShardArguments,
  partitionBrowserShardInventory,
  planBrowserBatchPorts,
  resolveBrowserShardLimits,
  shouldIsolateProcessIntensiveFiles,
} from '../scripts/run-browser-shard-bounded.mjs';

const inventoryItem = (
  file,
  tests,
  intensive = false,
  hostTerminal = false,
) => ({
  file,
  hostTerminal,
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
          [HOST_GPU_TERMINAL_REPORT_TAG],
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
      hostTerminal: true,
      intensive: true,
      tests: 2,
    },
    {
      file: 'tests/browser/nested/beta.spec.mjs',
      hostTerminal: false,
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

test('Windows receives a two-generation host-network budget', () => {
  const windowsLimits = resolveBrowserShardLimits(
    { RUNNER_OS: 'Windows' },
    'darwin',
  );
  assert.deepEqual(windowsLimits, {
    maxFilesPerProcess: 24,
    maxOrdinaryProcessesPerShard: 2,
    maxProcessesPerShard: 2,
    maxTestsPerProcess: 90,
  });
  assert.ok(Object.isFrozen(windowsLimits));
  assert.strictEqual(
    resolveBrowserShardLimits({}, 'win32'),
    windowsLimits,
  );

  const ordinaryLimits = resolveBrowserShardLimits(
    { RUNNER_OS: 'Linux' },
    'win32',
  );
  assert.deepEqual(ordinaryLimits, {
    maxFilesPerProcess: 6,
    maxOrdinaryProcessesPerShard: 8,
    maxProcessesPerShard: 9,
    maxTestsPerProcess: 40,
  });
  assert.notStrictEqual(ordinaryLimits, windowsLimits);
  assert.throws(
    () => resolveBrowserShardLimits({ RUNNER_OS: 42 }, 'linux'),
    /RUNNER_OS must be a string/,
  );
  assert.throws(
    () => resolveBrowserShardLimits({}, ''),
    /platform must be a non-empty string/,
  );
});

test('native-GPU stress files declare every test process-intensive', async () => {
  for (const filename of [
    'benchmark-harness-entry-point.spec.mjs',
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

test('host-GPU terminal stress is process-intensive and declared on every test', async () => {
  const filename = 'analysis-plot-surface-parity.spec.mjs';
  const source = await readFile(
    new URL(`./browser/${filename}`, import.meta.url),
    'utf8',
  );
  const declarations = source.match(/^\s*test\(/gm) ?? [];
  const terminalDeclarations = source.match(
    /,\s*HOST_GPU_TERMINAL,\s*async\s*\(/g,
  ) ?? [];

  assert.equal(declarations.length, 3, filename);
  assert.equal(terminalDeclarations.length, declarations.length, filename);
  assert.match(
    source,
    new RegExp(`['"]@${PROCESS_INTENSIVE_REPORT_TAG}['"]`),
    filename,
  );
  assert.match(
    source,
    new RegExp(`['"]@${HOST_GPU_TERMINAL_REPORT_TAG}['"]`),
    filename,
  );
});

test('browser batches bound file count, test weight, and process churn', () => {
  assert.equal(MAX_FILES_PER_BROWSER_PROCESS, 6);
  assert.equal(MAX_TESTS_PER_BROWSER_PROCESS, 40);
  assert.equal(MAX_ORDINARY_BROWSER_PROCESSES_PER_SHARD, 8);
  assert.equal(MAX_BROWSER_PROCESSES_PER_SHARD, 9);
  assert.equal(WINDOWS_MAX_FILES_PER_BROWSER_PROCESS, 24);
  assert.equal(WINDOWS_MAX_TESTS_PER_BROWSER_PROCESS, 90);
  assert.equal(WINDOWS_MAX_BROWSER_PROCESSES_PER_SHARD, 2);

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

  // Windows previously reached an explicit net::ERR_NO_BUFFER_SPACE with a
  // browser/server generation per file, and later missed the module bootstrap
  // after the third of eight bounded generations. The same exact 45-file,
  // 164-test inventory now reuses connections in two balanced lifetimes. Both
  // file and test growth remain hard-fenced; exceeding either requires another
  // CI shard instead of another Windows process on the same host.
  const windowsLimits = resolveBrowserShardLimits({ RUNNER_OS: 'Windows' });
  const windowsBatches = partitionBrowserShardInventory(
    inventory,
    false,
    windowsLimits,
  );
  assert.deepEqual(
    windowsBatches.map(batch => batch.files.length),
    [22, 23],
  );
  assert.deepEqual(
    windowsBatches.map(batch => batch.testCount),
    [79, 85],
  );
  assert.deepEqual(
    windowsBatches.flatMap(batch => batch.files),
    inventory.map(item => item.file),
  );

  // Linux WebKit's native GPU process crashed on the first ordinary test after
  // the four intensive edge-publication tests. A separate browser lifetime was
  // necessary but is not sufficient when the host GPU service outlives that
  // process, so the exact stress file is quarantined after every ordinary file.
  // The 45-file shard remains capped at nine processes and every other runtime
  // retains the eight-process plan above.
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
    [6, 6, 6, 6, 6, 6, 6, 2, 1],
  );
  assert.deepEqual(
    isolatedBatches.map(batch => batch.testCount),
    [32, 21, 13, 31, 16, 16, 24, 7, 4],
  );
  assert.deepEqual(isolatedBatches.at(-1).files, [inventory[0].file]);
  assert.deepEqual(
    isolatedBatches.flatMap(batch => batch.files),
    [...inventory.slice(1), inventory[0]].map(item => item.file),
  );

  // macOS Firefox completed the twenty-cycle Plotly retirement soak but left
  // the host GPU service degraded across every later Firefox process. The two
  // benchmark harness owners therefore run after ordinary conformance and the
  // analysis soak runs in the one host-terminal slot after both harnesses.
  // Each remains a separate singleton generation.
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
      index === 3 || index === 8 || index === 9,
      index === 3,
    ),
  );
  const isolatedBenchmarkBatches = partitionBrowserShardInventory(
    isolatedBenchmarkInventory,
    true,
  );
  assert.deepEqual(
    isolatedBenchmarkBatches.map(batch => batch.files.length),
    [6, 6, 4, 2, 4, 2, 1, 1, 1],
  );

  const windowsShardOneBatches = partitionBrowserShardInventory(
    isolatedBenchmarkInventory,
    false,
    windowsLimits,
  );
  assert.deepEqual(
    windowsShardOneBatches.map(batch => ({
      files: batch.files.length,
      tests: batch.testCount,
    })),
    [
      { files: 19, tests: 82 },
      { files: 8, tests: 84 },
    ],
  );
  assert.deepEqual(
    windowsShardOneBatches.flatMap(batch => batch.files),
    isolatedBenchmarkInventory.map(item => item.file),
  );
  assert.deepEqual(
    isolatedBenchmarkBatches.map(batch => batch.testCount),
    [21, 25, 8, 39, 37, 8, 1, 5, 22],
  );
  assert.deepEqual(
    isolatedBenchmarkBatches.slice(-3).map(batch => batch.files),
    [
      [isolatedBenchmarkInventory[8].file],
      [isolatedBenchmarkInventory[9].file],
      [isolatedBenchmarkInventory[3].file],
    ],
  );
  assert.deepEqual(
    isolatedBenchmarkBatches.flatMap(batch => batch.files),
    [
      ...isolatedBenchmarkInventory.filter(item => !item.intensive),
      isolatedBenchmarkInventory[8],
      isolatedBenchmarkInventory[9],
      isolatedBenchmarkInventory[3],
    ].map(item => item.file),
  );

  // More than one stress owner keeps its own relative order, and no ordinary
  // test can ever be scheduled behind either retained host-GPU generation.
  const multipleStressBatches = partitionBrowserShardInventory([
    inventoryItem('ordinary-a', 2),
    inventoryItem('stress-a', 3, true),
    inventoryItem('ordinary-b', 4),
    inventoryItem('stress-b', 5, true),
    inventoryItem('ordinary-c', 6),
    inventoryItem('host-terminal', 7, true, true),
  ], true);
  assert.deepEqual(
    multipleStressBatches.map(batch => ({
      files: batch.files,
      tests: batch.testCount,
    })),
    [
      {
        files: ['ordinary-a', 'ordinary-b', 'ordinary-c'],
        tests: 12,
      },
      { files: ['stress-a'], tests: 3 },
      { files: ['stress-b'], tests: 5 },
      { files: ['host-terminal'], tests: 7 },
    ],
  );

  assert.throws(
    () => partitionBrowserShardInventory([
      inventoryItem('terminal-a', 1, true, true),
      inventoryItem('terminal-b', 1, true, true),
    ], true),
    /place each in a separate CI shard/,
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
      hostTerminal: false,
      intensive: false,
      tests: 1,
    })),
  ).length, MAX_ORDINARY_BROWSER_PROCESSES_PER_SHARD);
  assert.throws(
    () => partitionBrowserShardInventory(
      Array.from({ length: fileCapacity + 1 }, (_unused, index) => ({
        file: String(index),
        hostTerminal: false,
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
        hostTerminal: false,
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
  assert.throws(
    () => partitionBrowserShardInventory([{
      file: 'invalid-terminal.spec.mjs',
      hostTerminal: true,
      intensive: false,
      tests: 1,
    }], true),
    /host-terminal and intensive flags/,
  );
  assert.throws(
    () => partitionBrowserShardInventory(
      [inventoryItem('valid.spec.mjs', 1)],
      false,
      {
        maxFilesPerProcess: 6,
        maxOrdinaryProcessesPerShard: 10,
        maxProcessesPerShard: 10,
        maxTestsPerProcess: 40,
      },
    ),
    /Browser shard limits must contain positive safe/,
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
