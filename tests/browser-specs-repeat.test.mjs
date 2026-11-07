import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  addRepeatSummary,
  browserTestImporters,
  parseRepeatArguments,
  planRepeatBatches,
  specsForChangedFiles,
  summarizeRepeatReport,
} from '../scripts/run-browser-specs-repeat.mjs';

test('the repeat runner defaults to five runs in every engine, in CI order', () => {
  assert.deepEqual(parseRepeatArguments([]), {
    paths: [],
    repeat: 5,
    projects: ['chromium', 'firefox', 'webkit'],
    grep: null,
  });
  assert.deepEqual(
    parseRepeatArguments([
      'tests/browser/cell-info.spec.mjs',
      '--repeat', '10',
      '--project=webkit',
      '--project', 'chromium',
      '--grep=hover card',
    ]),
    {
      paths: ['tests/browser/cell-info.spec.mjs'],
      repeat: 10,
      projects: ['chromium', 'webkit'],
      grep: 'hover card',
    },
  );
});

test('the repeat runner refuses what it cannot run as asked', () => {
  assert.throws(() => parseRepeatArguments(['--repeat=0']), /positive whole number/);
  assert.throws(() => parseRepeatArguments(['--repeat=2', '--repeat=3']), /once/);
  assert.throws(() => parseRepeatArguments(['--project=edge']), /chromium, firefox, webkit/);
  assert.throws(() => parseRepeatArguments(['--project=webkit', '--project=webkit']), /twice/);
  assert.throws(() => parseRepeatArguments(['--grep']), /requires a value/);
  assert.throws(() => parseRepeatArguments(['--retries=2']), /Unknown option/);
});

test('a changed helper runs every spec that imports it, through other helpers too', () => {
  const importers = browserTestImporters({
    'tests/browser/helpers/test.mjs': "import { device } from './device.mjs';\nexport { expect } from '@playwright/test';",
    'tests/browser/helpers/device.mjs': 'export const device = {};',
    'tests/browser/helpers/welcome.mjs': "const origins = await import('./origins.mjs');",
    'tests/browser/a.spec.mjs': "import { test } from './helpers/test.mjs';",
    'tests/browser/b.spec.mjs': "import './helpers/welcome.mjs';",
  });
  const { specs, unmapped } = specsForChangedFiles(
    [
      'tests/browser/helpers/device.mjs',
      'tests/browser/helpers/origins.mjs',
      'tests/browser/c.spec.mjs',
      'tests/browser/fixtures/data.h5ad',
    ],
    importers,
  );
  assert.deepEqual([...specs], [
    ['tests/browser/a.spec.mjs', 'imports tests/browser/helpers/device.mjs'],
    ['tests/browser/b.spec.mjs', 'imports tests/browser/helpers/origins.mjs'],
    ['tests/browser/c.spec.mjs', 'changed'],
  ]);
  assert.deepEqual(unmapped, ['tests/browser/fixtures/data.h5ad']);
});

test('the summary counts every run of every repetition and names the failing tests', () => {
  // The shape Playwright's JSON reporter writes (1.62 through 1.65) for `--repeat-each=3`:
  // one spec entry per repetition, describe blocks as nested suites.
  const report = {
    suites: [{
      title: 'shape.spec.mjs',
      file: 'shape.spec.mjs',
      specs: [
        { title: 'passes', file: 'shape.spec.mjs', line: 6, tests: [{ status: 'expected' }] },
        { title: 'skipped', file: 'shape.spec.mjs', line: 7, tests: [{ status: 'skipped' }] },
        { title: 'passes', file: 'shape.spec.mjs', line: 6, tests: [{ status: 'expected' }] },
      ],
      suites: [{
        title: 'group',
        file: 'shape.spec.mjs',
        specs: [
          { title: 'flips', file: 'shape.spec.mjs', line: 4, tests: [{ status: 'expected' }] },
          { title: 'flips', file: 'shape.spec.mjs', line: 4, tests: [{ status: 'unexpected' }] },
          { title: 'flips', file: 'shape.spec.mjs', line: 4, tests: [{ status: 'expected' }] },
        ],
      }],
    }],
    errors: [],
  };
  assert.deepEqual(summarizeRepeatReport(report), {
    passed: 4,
    failed: 1,
    skipped: 1,
    failures: [{ id: 'tests/browser/shape.spec.mjs:4 › group › flips', failed: 1, runs: 3 }],
    errors: [],
  });
  // Tests a spec file declares through a helper carry the helper as their
  // `file`; each is named by the file that runs it, and two files declaring
  // the same title through one helper stay two tests.
  const declared = file => ({
    title: file,
    file,
    specs: [{ title: 'walks', file: 'helpers/walk.mjs', line: 9, tests: [{ status: 'unexpected' }] }],
  });
  assert.deepEqual(summarizeRepeatReport({ suites: [declared('walk-1.spec.mjs'), declared('walk-2.spec.mjs')], errors: [] }).failures, [
    { id: 'tests/browser/walk-1.spec.mjs (helpers/walk.mjs:9) › walks', failed: 1, runs: 1 },
    { id: 'tests/browser/walk-2.spec.mjs (helpers/walk.mjs:9) › walks', failed: 1, runs: 1 },
  ]);
  assert.deepEqual(summarizeRepeatReport({ suites: [], errors: [{ message: 'Error: No tests found.' }] }).errors, [
    'Error: No tests found.',
  ]);
});

test('no browser outlives CI\'s bounds, however many runs are asked for', () => {
  const limits = { maxFilesPerProcess: 2, maxTestsPerProcess: 40 };
  const inventory = [
    { file: 'a', tests: 10 },
    { file: 'b', tests: 15 },
    { file: 'c', tests: 3 },
    { file: 'd', tests: 90 },
  ];
  // Files a and b (25 tests) once a process; c alone (the next group is full
  // by tests) 13 times a process; d above a process's tests, once a process.
  const batches = planRepeatBatches(inventory, 5, limits);
  assert.deepEqual(batches, [
    ...Array.from({ length: 5 }, () => ({ files: ['a', 'b'], repeatEach: 1 })),
    { files: ['c'], repeatEach: 5 },
    ...Array.from({ length: 5 }, () => ({ files: ['d'], repeatEach: 1 })),
  ]);
  // Every file runs exactly as many times as asked.
  for (const { file } of inventory) {
    const runs = batches.filter(batch => batch.files.includes(file)).reduce((sum, batch) => sum + batch.repeatEach, 0);
    assert.equal(runs, 5, file);
  }
  assert.deepEqual(planRepeatBatches([{ file: 'x', tests: 4 }], 25, limits), [
    { files: ['x'], repeatEach: 10 },
    { files: ['x'], repeatEach: 10 },
    { files: ['x'], repeatEach: 5 },
  ]);
});

test('an engine\'s summary adds up its browser processes', () => {
  const failure = { id: 't', failed: 1, runs: 2 };
  const total = [
    { passed: 3, failed: 1, skipped: 1, failures: [failure], errors: [] },
    { passed: 1, failed: 1, skipped: 0, failures: [failure, { id: 'u', failed: 0, runs: 1 }], errors: ['late'] },
  ].reduce(addRepeatSummary, { passed: 0, failed: 0, skipped: 0, failures: [], errors: [] });
  assert.deepEqual(total, {
    passed: 4,
    failed: 2,
    skipped: 1,
    failures: [{ id: 't', failed: 2, runs: 4 }, { id: 'u', failed: 0, runs: 1 }],
    errors: ['late'],
  });
});

test('the repeat command is the package script maintainers run', async () => {
  const scripts = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).scripts;
  assert.equal(scripts['test:browser:repeat'], 'node scripts/run-browser-specs-repeat.mjs');
});
