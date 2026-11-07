/**
 * A Playwright reporter that plans every shard of every project from one
 * listing (`playwright test --list --reporter=<this file>`): the tests each
 * `--shard=k/n` would run, for every k, by Playwright's own algorithm, so a
 * contract that checks every shard of the CI matrix loads the specs once
 * instead of once a shard (`tests/browser-shard-capacity-contract.test.mjs`).
 *
 * Playwright does not export its sharding, so `createTestGroups` and
 * `filterForShard` (`playwright/lib/runner/index.js`) are replicated here
 * for the version pinned below: tests are grouped by worker hash, then by
 * file (a file's tests in one group unless a suite runs them in parallel),
 * and each shard takes the groups whose first test falls in its share of
 * the tests, in order. Their inputs are the runner's own test objects
 * (`_workerHash`, `_requireFile`, a suite's `_parallelMode` and `_hooks`),
 * which the reporter is handed in the listing's process. A Playwright of
 * another version is refused: its sharding must be checked again
 * (the contract compares this plan with a real `--shard` listing as well).
 *
 * Output: JSON written to the file named by `CELLUCID_SHARD_PLAN_OUTPUT`:
 * `{ version, plans: { "<project> <k>/<n>": report } }`, each report shaped
 * as Playwright's JSON reporter's for that shard where
 * `extractBoundedShardInventory` (`scripts/run-browser-shard-bounded.mjs`)
 * reads it (`config.projects[].testDir`, one `suites[]` entry a test file
 * naming that `file`, its `specs[]` with `file` (the `test()` call's own
 * location, a helper module when the file declares its tests through one),
 * `tags` without their `@`, and one test naming its project).
 *
 * @module tests/helpers/shard-plan-reporter
 */

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/** The Playwright whose sharding this replicates. */
export const PINNED_PLAYWRIGHT_VERSION = '1.65.0';

const installedVersion = createRequire(import.meta.url)('playwright/package.json').version;

/**
 * `createTestGroups(projectSuite, expectedParallelism)`, Playwright 1.65.0
 * (its groups' `locks`, which only the dispatcher reads, left out).
 */
function createTestGroups(projectSuite, expectedParallelism) {
  const groups = new Map();
  const createGroup = test => ({
    workerHash: test._workerHash,
    requireFile: test._requireFile,
    repeatEachIndex: test.repeatEachIndex,
    projectId: test._projectId,
    tests: [],
  });
  for (const test of projectSuite.allTests()) {
    let withWorkerHash = groups.get(test._workerHash);
    if (!withWorkerHash) {
      withWorkerHash = new Map();
      groups.set(test._workerHash, withWorkerHash);
    }
    let withRequireFile = withWorkerHash.get(test._requireFile);
    if (!withRequireFile) {
      withRequireFile = { general: createGroup(test), parallel: new Map(), parallelWithHooks: createGroup(test) };
      withWorkerHash.set(test._requireFile, withRequireFile);
    }
    let insideParallel = false;
    let outerMostSequentialSuite;
    let hasAllHooks = false;
    for (let parent = test.parent; parent; parent = parent.parent) {
      if (parent._parallelMode === 'serial' || parent._parallelMode === 'default') outerMostSequentialSuite = parent;
      insideParallel = insideParallel || parent._parallelMode === 'parallel';
      hasAllHooks = hasAllHooks || parent._hooks.some(hook => hook.type === 'beforeAll' || hook.type === 'afterAll');
    }
    if (insideParallel) {
      if (hasAllHooks && !outerMostSequentialSuite) {
        withRequireFile.parallelWithHooks.tests.push(test);
      } else {
        const key = outerMostSequentialSuite || test;
        let group = withRequireFile.parallel.get(key);
        if (!group) {
          group = createGroup(test);
          withRequireFile.parallel.set(key, group);
        }
        group.tests.push(test);
      }
    } else {
      withRequireFile.general.tests.push(test);
    }
  }
  const result = [];
  for (const withWorkerHash of groups.values()) {
    for (const withRequireFile of withWorkerHash.values()) {
      if (withRequireFile.general.tests.length) result.push(withRequireFile.general);
      result.push(...withRequireFile.parallel.values());
      const parallelWithHooksGroupSize = Math.ceil(withRequireFile.parallelWithHooks.tests.length / expectedParallelism);
      let lastGroup;
      for (const test of withRequireFile.parallelWithHooks.tests) {
        if (!lastGroup || lastGroup.tests.length >= parallelWithHooksGroupSize) {
          lastGroup = createGroup(test);
          result.push(lastGroup);
        }
        lastGroup.tests.push(test);
      }
    }
  }
  return result;
}

/**
 * `filterForShard(shard, weights, testGroups)`, Playwright 1.65.0, equal
 * weights: a group weighs its tests not expected to be skipped (every test,
 * when no group has one), and a group of none is placed with the test before it.
 */
function filterForShard(shard, testGroups) {
  const weights = Array.from({ length: shard.total }, () => 1);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const activeSizes = testGroups.map(group => group.tests.filter(test => test.expectedStatus !== 'skipped').length);
  const groupSizes = activeSizes.some(Boolean) ? activeSizes : testGroups.map(group => group.tests.length);
  const shardableTotal = groupSizes.reduce((a, b) => a + b, 0);
  const shardSizes = weights.map(w => Math.floor(w * shardableTotal / totalWeight));
  const remainder = shardableTotal - shardSizes.reduce((a, b) => a + b, 0);
  for (let i = 0; i < remainder; i++) shardSizes[i % shardSizes.length]++;
  let from = 0;
  for (let i = 0; i < shard.current - 1; i++) from += shardSizes[i];
  const to = from + shardSizes[shard.current - 1];
  let current = 0;
  const result = new Set();
  testGroups.forEach((group, index) => {
    const position = groupSizes[index] ? current : Math.max(current - 1, 0);
    if (position >= from && position < to) result.add(group);
    current += groupSizes[index];
  });
  return result;
}

/** The test file whose loading declared `test`: its `file` suite's location. */
function testFileOf(test) {
  for (let suite = test.parent; suite; suite = suite.parent) {
    if (suite.type === 'file') {
      const file = suite.location?.file;
      if (typeof file !== 'string' || file === '') throw new Error(`The file suite of "${test.title}" names no file.`);
      return file;
    }
  }
  throw new Error(`"${test.title}" belongs to no file suite.`);
}

/** The JSON reporter's suites for `tests`: one a test file, in order. */
function fileSuites(tests, projectName) {
  const byFile = new Map();
  for (const test of tests) {
    const file = testFileOf(test);
    const suite = byFile.get(file) ?? { title: file, file, specs: [] };
    suite.specs.push({
      title: test.title,
      file: test.location.file,
      tags: test.tags.map(tag => tag.substring(1)),
      tests: [{ projectName }],
    });
    byFile.set(file, suite);
  }
  return [...byFile.values()];
}

export default class ShardPlanReporter {
  constructor() {
    this.output = process.env.CELLUCID_SHARD_PLAN_OUTPUT;
    this.total = Number(process.env.CELLUCID_SHARD_PLAN_TOTAL);
    if (typeof this.output !== 'string' || this.output === '') throw new Error('CELLUCID_SHARD_PLAN_OUTPUT names the plan file.');
    if (!Number.isSafeInteger(this.total) || this.total < 1) throw new Error('CELLUCID_SHARD_PLAN_TOTAL is the shard count.');
    if (installedVersion !== PINNED_PLAYWRIGHT_VERSION) {
      throw new Error(`The shard plan replicates Playwright ${PINNED_PLAYWRIGHT_VERSION}'s sharding; ${installedVersion} is installed: check createTestGroups and filterForShard again.`);
    }
  }

  printsToStdio() {
    return false;
  }

  onBegin(config, suite) {
    this.config = config;
    this.suite = suite;
  }

  onError(error) {
    this.errors = [...(this.errors ?? []), error.message ?? String(error)];
  }

  onEnd() {
    const plans = {};
    for (const projectSuite of this.suite.suites) {
      const project = projectSuite.project();
      const groups = createTestGroups(projectSuite, this.total);
      for (let current = 1; current <= this.total; current += 1) {
        const tests = [...filterForShard({ current, total: this.total }, groups)].flatMap(group => group.tests);
        plans[`${project.name} ${current}/${this.total}`] = {
          errors: this.errors ?? [],
          config: { projects: [{ name: project.name, testDir: project.testDir }] },
          suites: fileSuites(tests, project.name),
        };
      }
    }
    writeFileSync(this.output, JSON.stringify({ version: installedVersion, plans }));
  }
}
