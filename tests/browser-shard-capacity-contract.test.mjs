/**
 * Every CI browser shard of the real spec inventory fits the bounded runner.
 *
 * `scripts/run-browser-shard-bounded.mjs` refuses a shard whose files need
 * more browser processes than its runner allows ("increase the CI shard
 * count"). That refusal is decided by the spec files themselves, so a new
 * spec can push a shard over its bound without touching the workflow. This
 * plans every shard of the workflow's matrix, for every engine on every
 * runner the matrix uses, from Playwright's own sharding -- the same plan
 * the runner makes -- so the overflow is caught here instead of in CI.
 *
 * One listing plans every shard of every project
 * (`tests/helpers/shard-plan-reporter.mjs`, Playwright's `createTestGroups`
 * and `filterForShard` replicated for the pinned version), and real
 * `--shard` listings of one engine (every other shard and the last: every
 * boundary between two shards) are compared with their plans, test for
 * test, so a change of Playwright's sharding is caught: 5 processes. It listed each of the 21 shards in a
 * process of its own before: 26 s on an idle machine and 166 s at a load
 * average of 42, past the suite's 120 s a test, in 4 of 13 loaded runs
 * (2026-11-01).
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  extractBoundedShardInventory,
  partitionBrowserShardInventory,
  resolveBrowserShardLimits,
  shouldIsolateProcessIntensiveFiles,
} from '../scripts/run-browser-shard-bounded.mjs';
import { PINNED_PLAYWRIGHT_VERSION } from './helpers/shard-plan-reporter.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const playwrightCli = createRequire(import.meta.url).resolve('@playwright/test/cli');

const shardPlanReporter = fileURLToPath(new URL('./helpers/shard-plan-reporter.mjs', import.meta.url));

/** Run Playwright's CLI on the repository; resolve its stdout. */
function playwright(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [playwrightCli, 'test', ...args], {
      cwd: repositoryRoot,
      env: { ...process.env, FORCE_COLOR: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      // The JSON reporter writes configuration and load errors to stdout.
      reject(new Error(`playwright ${args.join(' ')} exited ${code}: ${stderr}${stdout.slice(-4000)}`));
    });
  });
}

/** Every spec of a JSON shard report, as file and title. */
function listedTests(report, testDir) {
  const tests = [];
  const walk = suites => {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) tests.push(`${resolve(testDir, spec.file)} › ${spec.title}`);
      walk(suite.suites);
    }
  };
  walk(report.suites);
  return tests.sort();
}

test('every browser shard of the CI matrix fits its runner\'s bounded processes', async () => {
  const workflow = await readFile(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
  const matrixShards = workflow.match(/^\s+shard: (\[[^\]\n]+\])$/m);
  assert.ok(matrixShards, 'the browser matrix lists its shards');
  const shards = JSON.parse(matrixShards[1]);
  assert.ok(shards.length > 0);

  const cacheRoot = await mkdtemp(join(tmpdir(), 'cellucid-shard-capacity-'));
  let reports;
  let compared;
  try {
    const planFile = join(cacheRoot, 'plan.json');
    const environment = { PWTEST_CACHE_DIR: join(cacheRoot, 'cache') };
    await playwright(['--list', `--reporter=${shardPlanReporter}`], {
      ...environment,
      CELLUCID_SHARD_PLAN_OUTPUT: planFile,
      CELLUCID_SHARD_PLAN_TOTAL: String(shards.length),
    });
    const plan = JSON.parse(await readFile(planFile, 'utf8'));
    assert.equal(plan.version, PINNED_PLAYWRIGHT_VERSION, 'the plan replicates the installed Playwright');
    reports = new Map(Object.entries(plan.plans));
    // Real shards, test for test, against the plan: every other shard and
    // the last, whose first and last tests are every boundary between two
    // shards, of the engine whose files carry the isolation tags. A change
    // of Playwright's sharding moves a boundary.
    const testDir = plan.plans[`webkit ${shards[0]}`].config.projects[0].testDir;
    compared = [];
    for (const [index, shard] of shards.entries()) {
      if (index % 2 !== 0 && index !== shards.length - 1) continue;
      const real = JSON.parse(await playwright(['--list', '--reporter=json', '--project=webkit', `--shard=${shard}`], environment));
      compared.push({ shard, real: listedTests(real, testDir), planned: listedTests(reports.get(`webkit ${shard}`), testDir) });
    }
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
  for (const { shard, real, planned } of compared) {
    assert.ok(real.length > 0, `webkit ${shard} lists tests`);
    assert.deepEqual(planned, real, `the plan of webkit ${shard} is Playwright's own shard`);
  }

  let files = 0;
  for (const runnerOs of ['Linux', 'macOS', 'Windows']) {
    const environment = { RUNNER_OS: runnerOs };
    const limits = resolveBrowserShardLimits(environment);
    for (const project of ['chromium', 'firefox', 'webkit']) {
      for (const shard of shards) {
        const inventory = extractBoundedShardInventory(reports.get(`${project} ${shard}`), project);
        if (runnerOs === 'Linux') files += inventory.length;
        const isolate = shouldIsolateProcessIntensiveFiles(project, environment)
          && inventory.some(item => item.intensive);
        assert.doesNotThrow(
          () => partitionBrowserShardInventory(inventory, isolate, limits),
          `${runnerOs} ${project} shard ${shard} must fit its bounded processes`,
        );
      }
    }
  }
  assert.ok(files > 0, 'the shards hold the spec files');
});
