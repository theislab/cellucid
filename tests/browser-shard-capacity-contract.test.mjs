/**
 * Every CI browser shard of the real spec inventory fits the bounded runner.
 *
 * `scripts/run-browser-shard-bounded.mjs` refuses a shard whose files need
 * more browser processes than its runner allows ("increase the CI shard
 * count"). That refusal is decided by the spec files themselves, so a new
 * spec can push a shard over its bound without touching the workflow. This
 * plans every shard of the workflow's matrix, for every engine on every
 * runner the matrix uses, from Playwright's own shard listing — the same
 * plan the runner makes — so the overflow is caught here instead of in CI.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  extractBoundedShardInventory,
  partitionBrowserShardInventory,
  resolveBrowserShardLimits,
  shouldIsolateProcessIntensiveFiles,
} from '../scripts/run-browser-shard-bounded.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const playwrightCli = createRequire(import.meta.url).resolve('@playwright/test/cli');

/**
 * Every listing loads every spec file, so Playwright's compilation cache is
 * what a listing mostly costs: cold, one takes about four times the CPU of a
 * warm one. Concurrent listings must not share that cache, though: on
 * Windows two processes renaming the same cache entry fail. So the first
 * listing runs alone and fills a cache, each concurrent listing gets its own
 * copy of it, and every later listing reads warm entries only.
 */
const LISTING_CONCURRENCY = Math.max(1, availableParallelism() - 1);

function listShard(project, shard, cacheDirectory) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [playwrightCli, 'test', '--list', '--reporter=json', `--project=${project}`, `--shard=${shard}`],
      {
        cwd: repositoryRoot,
        env: { ...process.env, FORCE_COLOR: '0', PWTEST_CACHE_DIR: cacheDirectory },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve(JSON.parse(stdout));
        return;
      }
      // The JSON reporter writes configuration and load errors to stdout.
      let reported = stdout.slice(-4000);
      try {
        reported = JSON.stringify(JSON.parse(stdout).errors ?? []);
      } catch {}
      reject(new Error(`playwright --list ${project} ${shard} exited ${code}: ${stderr}${reported}`));
    });
  });
}

test('every browser shard of the CI matrix fits its runner\'s bounded processes', async () => {
  const workflow = await readFile(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
  const matrixShards = workflow.match(/^\s+shard: (\[[^\]\n]+\])$/m);
  assert.ok(matrixShards, 'the browser matrix lists its shards');
  const shards = JSON.parse(matrixShards[1]);
  assert.ok(shards.length > 0);

  const reports = new Map();
  const pending = ['chromium', 'firefox', 'webkit'].flatMap(project => shards.map(shard => [project, shard]));
  const cacheRoot = await mkdtemp(join(tmpdir(), 'cellucid-shard-capacity-'));
  try {
    const listNext = async cacheDirectory => {
      const [project, shard] = pending.shift();
      reports.set(`${project} ${shard}`, await listShard(project, shard, cacheDirectory));
    };
    const warmCache = join(cacheRoot, '0');
    await listNext(warmCache);
    const workers = Math.min(LISTING_CONCURRENCY, pending.length);
    const caches = [warmCache];
    for (let worker = 1; worker < workers; worker += 1) {
      const cacheDirectory = join(cacheRoot, String(worker));
      await cp(warmCache, cacheDirectory, { recursive: true });
      caches.push(cacheDirectory);
    }
    await Promise.all(caches.map(async cacheDirectory => {
      while (pending.length > 0) await listNext(cacheDirectory);
    }));
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
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
