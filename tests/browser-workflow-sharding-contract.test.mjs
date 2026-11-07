import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

test('browser CI shards every engine with bounded process generations', async () => {
  const [workflow, playwrightConfig, packageJson] = await Promise.all([
    readFile(
      new URL('../.github/workflows/test.yml', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('../playwright.config.mjs', import.meta.url),
      'utf8',
    ),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ]);

  assert.match(
    workflow,
    /name: \$\{\{ matrix\.os \}\} \/ \$\{\{ matrix\.browser \}\} \/ shard \$\{\{ matrix\.shard \}\}/,
  );
  // Pushes and pull requests shard every engine on Linux plus WebKit on
  // macOS; the nightly schedule and manual dispatch shard every engine on
  // every operating system.
  assert.match(workflow, /schedule:\n\s+- cron: "[^"]+"\n\s+workflow_dispatch:/);
  assert.match(
    workflow,
    /os: \$\{\{ fromJSON\(\(github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'\) && '\["ubuntu-latest", "macos-latest", "windows-latest"\]' \|\| '\["ubuntu-latest"\]'\) \}\}\n\s+browser: \[chromium, firefox, webkit\]\n\s+shard: \["1\/8", "2\/8", "3\/8", "4\/8", "5\/8", "6\/8", "7\/8", "8\/8"\]/,
  );
  for (const shard of ['1/8', '2/8', '3/8', '4/8', '5/8', '6/8', '7/8', '8/8']) {
    assert.ok(
      workflow.includes(
        `- os: macos-latest\n            browser: webkit\n            shard: "${shard}"`,
      ),
      `every push must run macOS WebKit shard ${shard}`,
    );
  }
  assert.match(
    workflow,
    /browsers:[\s\S]*?timeout-minutes: 75[\s\S]*?strategy:\n\s+fail-fast: false/,
  );
  assert.match(playwrightConfig, /fullyParallel: false,/);
  assert.match(playwrightConfig, /workers: 1,/);
  assert.doesNotMatch(workflow, /--workers(?:=|\s)/);

  const shardArguments = workflow.match(
    /--shard=\$\{\{ matrix\.shard \}\}/g,
  ) ?? [];
  assert.equal(
    shardArguments.length,
    3,
    'the headed Linux-Firefox and headless browser partitions and the control walk must all shard',
  );
  assert.match(
    workflow,
    /if: matrix\.browser == 'firefox' && runner\.os == 'Linux'\n\s+run: >-\n\s+xvfb-run --auto-servernum --\n\s+npm run test:browser:bounded --\n\s+--project=firefox\n\s+--headed\n\s+--shard=\$\{\{ matrix\.shard \}\}/,
  );
  assert.match(
    workflow,
    /if: matrix\.browser != 'firefox' \|\| runner\.os != 'Linux'\n\s+run: >-\n\s+npm run test:browser:bounded --\n\s+--project=\$\{\{ matrix\.browser \}\}\n\s+--shard=\$\{\{ matrix\.shard \}\}/,
  );
  assert.doesNotMatch(
    workflow,
    /npm run test:browser --[\s\S]{0,160}?--shard=/,
    'no full shard may retain one accumulating browser process',
  );
  assert.doesNotMatch(
    workflow,
    /test:browser:isolated/,
    'no shard may return to one browser and server process per file',
  );
  assert.equal(
    JSON.parse(packageJson).scripts['test:browser:bounded'],
    'node scripts/run-browser-shard-bounded.mjs',
  );

  // The two full-suite conditions are a complete, disjoint partition: Linux
  // Firefox remains headed under Xvfb; every other cell is headless. Both
  // use the same bounded process runner. The WebGL2 runtime is recorded
  // once per engine and operating system (its log line names the GL
  // implementation the cell ran on), not once per shard.
  assert.match(
    workflow,
    /if: matrix\.browser == 'firefox' && runner\.os == 'Linux' && matrix\.shard == '1\/8'\n\s+run: >-\n\s+xvfb-run --auto-servernum --\n\s+npm run test:browser --\n\s+--project=firefox\n\s+--headed\n\s+tests\/browser\/webgl2-runtime\.spec\.mjs/,
  );
  assert.match(
    workflow,
    /if: \(matrix\.browser != 'firefox' \|\| runner\.os != 'Linux'\) && matrix\.shard == '1\/8'\n\s+run: >-\n\s+npm run test:browser --\n\s+--project=\$\{\{ matrix\.browser \}\}\n\s+tests\/browser\/webgl2-runtime\.spec\.mjs/,
  );
  // A red job keeps the host's picture beside Playwright's: the kernel log
  // on Linux, sockets and memory on Windows, memory and graphics on macOS.
  for (const os of ['Linux', 'Windows', 'macOS']) {
    assert.match(
      workflow,
      new RegExp(`if: failure\\(\\) && runner\\.os == '${os}'`),
      `a failed ${os} job records its host state`,
    );
  }
  assert.doesNotMatch(
    workflow,
    /run: npm run test:browser -- --project=/,
    'no unsharded full browser suite may remain',
  );
});

/** The text of the job `id` of the workflow: from its key to the next job's. */
function jobOf(workflow, id) {
  const job = new RegExp(`\\n  ${id}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z-]*:\\n|$)`).exec(workflow)?.[1];
  assert.ok(job, `the workflow has the job ${id}`);
  return job;
}

test('the control walk runs in a job of its own, a share a job, and not in the browser shards', async () => {
  const [workflow, walkFiles] = await Promise.all([
    readFile(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8'),
    readdir(new URL('./browser/', import.meta.url)),
  ]);
  const browsers = jobOf(workflow, 'browsers');
  const walk = jobOf(workflow, 'control-walk');
  const shares = walkFiles.filter(file => /^control-walk-\d+-of-\d+\.spec\.mjs$/.test(file)).length;
  assert.ok(shares > 0, 'the walk has spec files');

  // The browser shards leave the walk out; the walk job runs it alone
  // (`playwright.config.mjs`), one shard a spec file, on Chromium.
  assert.match(browsers, /\n    env:\n      CELLUCID_CONTROL_WALK: apart\n/);
  assert.match(walk, /\n    env:\n      CELLUCID_CONTROL_WALK: only\n/);
  assert.match(walk, /name: \$\{\{ matrix\.os \}\} \/ \$\{\{ matrix\.browser \}\} \/ control walk \$\{\{ matrix\.shard \}\}/);
  assert.match(walk, /\n\s+browser: \[chromium\]\n/);
  const walkShards = JSON.parse(/\n\s+shard: (\[[^\]\n]+\])\n/.exec(walk)?.[1] ?? 'null');
  assert.deepEqual(
    walkShards,
    Array.from({ length: shares }, (_, index) => `${index + 1}/${shares}`),
    'the walk job runs a shard for each of the walk\'s spec files',
  );
  // The same operating systems as the browser job's, for every event.
  const osOf = job => /\n\s+os: (\$\{\{ fromJSON\(.*\) \}\})\n/.exec(job)?.[1];
  assert.ok(osOf(browsers));
  assert.equal(osOf(walk), osOf(browsers));
  assert.match(walk, /timeout-minutes: 75\n\s+strategy:\n\s+fail-fast: false/);
  assert.match(
    walk,
    /\n\s+run: >-\n\s+npm run test:browser:bounded --\n\s+--project=\$\{\{ matrix\.browser \}\}\n\s+--shard=\$\{\{ matrix\.shard \}\}\n/,
  );

  // Its setup and evidence steps are the browser job's own, by alias, in
  // the browser job's order.
  const anchors = [...browsers.matchAll(/^ {6}- &([a-z-]+)$/gm)].map(match => match[1]);
  assert.deepEqual(anchors, [
    'check-out',
    'install-node',
    'install-dependencies',
    'widen-windows-ports',
    'install-linux-libraries',
    'install-engine',
    'record-linux-host',
    'record-windows-host',
    'record-macos-host',
    'upload-failure-evidence',
  ]);
  const aliases = [...walk.matchAll(/^ {6}- \*([a-z-]+)$/gm)].map(match => match[1]);
  assert.deepEqual(aliases, anchors);
  // An artifact name is unique in a run: both jobs' evidence names its job.
  assert.match(browsers, /name: playwright-failure-\$\{\{ github\.job \}\}-\$\{\{ strategy\.job-index \}\}-/);
});
