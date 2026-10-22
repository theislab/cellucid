import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
    /os: \$\{\{ fromJSON\(\(github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'\) && '\["ubuntu-latest", "macos-latest", "windows-latest"\]' \|\| '\["ubuntu-latest"\]'\) \}\}\n\s+browser: \[chromium, firefox, webkit\]\n\s+shard: \["1\/7", "2\/7", "3\/7", "4\/7", "5\/7", "6\/7", "7\/7"\]/,
  );
  for (const shard of ['1/7', '2/7', '3/7', '4/7', '5/7', '6/7', '7/7']) {
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
    2,
    'the headed Linux-Firefox and headless browser partitions must both shard',
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
    /if: matrix\.browser == 'firefox' && runner\.os == 'Linux' && matrix\.shard == '1\/7'\n\s+run: >-\n\s+xvfb-run --auto-servernum --\n\s+npm run test:browser --\n\s+--project=firefox\n\s+--headed\n\s+tests\/browser\/webgl2-runtime\.spec\.mjs/,
  );
  assert.match(
    workflow,
    /if: \(matrix\.browser != 'firefox' \|\| runner\.os != 'Linux'\) && matrix\.shard == '1\/7'\n\s+run: >-\n\s+npm run test:browser --\n\s+--project=\$\{\{ matrix\.browser \}\}\n\s+tests\/browser\/webgl2-runtime\.spec\.mjs/,
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
