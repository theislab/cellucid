/**
 * Every CI browser shard of the real spec inventory fits the bounded runner.
 *
 * `scripts/run-browser-shard-bounded.mjs` refuses a shard whose files need
 * more browser processes than its runner allows ("increase the CI shard
 * count"). That refusal is decided by the spec files themselves, so a new
 * spec can push a shard over its bound without touching the workflow. This
 * plans every shard of both browser jobs' matrices (`browsers`, with the
 * control walk set apart, and `control-walk`, the walk alone: the
 * `CELLUCID_CONTROL_WALK` each job sets), for every engine of the job on
 * every runner the matrix uses, from Playwright's own sharding -- the same
 * plan the runner makes -- so the overflow is caught here instead of in CI.
 * The browser job's shards hold no file of the walk, and the walk job's
 * shards hold each of its files, one a shard.
 *
 * One listing a job plans every shard of every project
 * (`tests/helpers/shard-plan-reporter.mjs`, Playwright's `createTestGroups`
 * and `filterForShard` replicated for the pinned version), and real
 * `--shard` listings of one engine (every other shard and the last: every
 * boundary between two shards) are compared with their plans, test for
 * test, so a change of Playwright's sharding is caught: 6 processes for the
 * browser job and 4 for the walk job, which load the walk's files alone. A
 * listing of each of the 21 shards in a process of its own is too slow under
 * load (measured: 38_decisions_testing_and_hosted_runners.md).
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
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

/**
 * Every spec of a JSON shard report, as the test file that holds it (its
 * top-level suite, which the bounded runner replays) and its title.
 */
function listedTests(report, testDir) {
  const tests = [];
  const walk = (suites, file) => {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) tests.push(`${resolve(testDir, file)} › ${spec.title}`);
      walk(suite.suites, file);
    }
  };
  for (const fileSuite of report.suites ?? []) walk([fileSuite], fileSuite.file);
  return tests.sort();
}

/** The text of the job `id` of the workflow: from its key to the next job's. */
function jobOf(workflow, id) {
  const job = new RegExp(`\\n  ${id}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z-]*:\\n|$)`).exec(workflow)?.[1];
  assert.ok(job, `the workflow has the job ${id}`);
  return job;
}

/**
 * A browser job's matrix: its shards, its engines, and the
 * `CELLUCID_CONTROL_WALK` it runs with.
 */
function browserJob(workflow, id) {
  const job = jobOf(workflow, id);
  const shards = /\n\s+shard: (\[[^\]\n]+\])\n/.exec(job);
  const projects = /\n\s+browser: \[([^\]\n]+)\]\n/.exec(job);
  const controlWalk = /\n\s+CELLUCID_CONTROL_WALK: ([a-z]+)\n/.exec(job);
  assert.ok(shards && projects && controlWalk, `the ${id} matrix lists its shards and engines, and its job sets CELLUCID_CONTROL_WALK`);
  return {
    id,
    shards: JSON.parse(shards[1]),
    projects: projects[1].split(',').map(project => project.trim()),
    controlWalk: controlWalk[1],
  };
}

const CONTROL_WALK_FILE = /[\\/]control-walk-\d+-of-\d+\.spec\.mjs$/;

/**
 * Every shard of `job` planned from one listing, and real `--shard` listings
 * of `compared` (every other shard and the last) beside their plans.
 */
async function planJob(job, compared, cacheRoot) {
  const planFile = join(cacheRoot, `${job.id}.json`);
  const environment = { PWTEST_CACHE_DIR: join(cacheRoot, 'cache'), CELLUCID_CONTROL_WALK: job.controlWalk };
  await playwright(['--list', `--reporter=${shardPlanReporter}`], {
    ...environment,
    CELLUCID_SHARD_PLAN_OUTPUT: planFile,
    CELLUCID_SHARD_PLAN_TOTAL: String(job.shards.length),
  });
  const plan = JSON.parse(await readFile(planFile, 'utf8'));
  assert.equal(plan.version, PINNED_PLAYWRIGHT_VERSION, 'the plan replicates the installed Playwright');
  const reports = new Map(Object.entries(plan.plans));
  // Real shards, test for test, against the plan: every other shard and
  // the last, whose first and last tests are every boundary between two
  // shards. A change of Playwright's sharding moves a boundary.
  const testDir = plan.plans[`${compared} ${job.shards[0]}`].config.projects[0].testDir;
  const comparisons = [];
  for (const [index, shard] of job.shards.entries()) {
    if (index % 2 !== 0 && index !== job.shards.length - 1) continue;
    const real = JSON.parse(await playwright(['--list', '--reporter=json', `--project=${compared}`, `--shard=${shard}`], environment));
    comparisons.push({ shard, real: listedTests(real, testDir), planned: listedTests(reports.get(`${compared} ${shard}`), testDir) });
  }
  return { reports, comparisons };
}

// Playwright lists the specs ten times here, each a process of its own (four of them the walk's
// files alone): slow on hosted runners and on a machine at work, past the suite's fence for a
// hung test. Nothing here waits for anything but those processes, so this fence is only for one of
// them hanging.
test('every browser shard of the CI matrix fits its runner\'s bounded processes', { timeout: 600_000 }, async () => {
  const workflow = await readFile(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
  // The engine compared with real listings: in the browser job, the one
  // whose files carry the isolation tags.
  const jobs = [
    { job: browserJob(workflow, 'browsers'), compared: 'webkit' },
    { job: browserJob(workflow, 'control-walk'), compared: 'chromium' },
  ];
  assert.deepEqual(jobs.map(({ job }) => job.controlWalk), ['apart', 'only']);
  for (const { job, compared } of jobs) {
    assert.ok(job.shards.length > 0);
    assert.ok(job.projects.includes(compared), `${job.id} runs ${compared}`);
  }

  const cacheRoot = await mkdtemp(join(tmpdir(), 'cellucid-shard-capacity-'));
  const planned = new Map();
  try {
    for (const { job, compared } of jobs) planned.set(job.id, await planJob(job, compared, cacheRoot));
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }

  for (const { job, compared } of jobs) {
    for (const { shard, real, planned: plan } of planned.get(job.id).comparisons) {
      assert.ok(real.length > 0, `${job.id} ${compared} ${shard} lists tests`);
      assert.deepEqual(plan, real, `the plan of ${job.id} ${compared} ${shard} is Playwright's own shard`);
    }
  }

  const walkFiles = [];
  for (const { job } of jobs) {
    const { reports } = planned.get(job.id);
    let files = 0;
    for (const runnerOs of ['Linux', 'macOS', 'Windows']) {
      const environment = { RUNNER_OS: runnerOs };
      const limits = resolveBrowserShardLimits(environment);
      for (const project of job.projects) {
        for (const shard of job.shards) {
          const inventory = extractBoundedShardInventory(reports.get(`${project} ${shard}`), project);
          if (runnerOs === 'Linux') files += inventory.length;
          const walk = inventory.filter(item => CONTROL_WALK_FILE.test(item.file));
          if (job.controlWalk === 'apart') {
            assert.deepEqual(walk, [], `${job.id} ${project} shard ${shard} holds no control-walk file`);
          } else {
            assert.deepEqual(walk, inventory, `${job.id} ${project} shard ${shard} holds the control walk alone`);
            assert.equal(inventory.length, 1, `${job.id} ${project} shard ${shard} is one share of the walk`);
            if (runnerOs === 'Linux') walkFiles.push(inventory[0].file);
          }
          const isolate = shouldIsolateProcessIntensiveFiles(project, environment)
            && inventory.some(item => item.intensive);
          assert.doesNotThrow(
            () => partitionBrowserShardInventory(inventory, isolate, limits),
            `${runnerOs} ${job.id} ${project} shard ${shard} must fit its bounded processes`,
          );
        }
      }
    }
    assert.ok(files > 0, `the ${job.id} shards hold the spec files`);
  }
  // Each of the walk's spec files is one shard of the walk job.
  const specFiles = (await readdir(new URL('./browser/', import.meta.url)))
    .filter(file => CONTROL_WALK_FILE.test(`/${file}`))
    .map(file => `tests/browser/${file}`);
  assert.deepEqual([...walkFiles].sort(), specFiles.sort(), 'the walk job runs each of the walk\'s files once');
});
