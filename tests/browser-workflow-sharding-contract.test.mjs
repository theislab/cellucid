import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('browser CI shards every engine with per-file process isolation', async () => {
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
  assert.match(
    workflow,
    /os: \[ubuntu-latest, macos-latest, windows-latest\]\n\s+browser: \[chromium, firefox, webkit\]\n\s+shard: \["1\/2", "2\/2"\]/,
  );
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
    /if: matrix\.browser == 'firefox' && runner\.os == 'Linux'\n\s+run: >-\n\s+xvfb-run --auto-servernum --\n\s+npm run test:browser:isolated --\n\s+--project=firefox\n\s+--headed\n\s+--shard=\$\{\{ matrix\.shard \}\}/,
  );
  assert.match(
    workflow,
    /if: matrix\.browser != 'firefox' \|\| runner\.os != 'Linux'\n\s+run: >-\n\s+npm run test:browser:isolated --\n\s+--project=\$\{\{ matrix\.browser \}\}\n\s+--shard=\$\{\{ matrix\.shard \}\}/,
  );
  assert.doesNotMatch(
    workflow,
    /npm run test:browser --[\s\S]{0,160}?--shard=/,
    'no full shard may retain one accumulating browser process',
  );
  assert.equal(
    JSON.parse(packageJson).scripts['test:browser:isolated'],
    'node scripts/run-browser-shard-isolated.mjs',
  );

  // The two full-suite conditions are a complete, disjoint partition: Linux
  // Firefox remains headed under Xvfb; every other cell is headless. Both
  // recycle the browser per file. The explicit WebGL probes run once rather
  // than once per shard.
  assert.match(
    workflow,
    /if: matrix\.browser == 'firefox' && runner\.os == 'Linux' && matrix\.shard == '1\/2'[\s\S]*?tests\/browser\/webgl2-runtime\.spec\.mjs/,
  );
  assert.match(
    workflow,
    /if: matrix\.browser == 'firefox' && runner\.os != 'Linux' && matrix\.shard == '1\/2'[\s\S]*?tests\/browser\/webgl2-runtime\.spec\.mjs/,
  );
  assert.doesNotMatch(
    workflow,
    /run: npm run test:browser -- --project=/,
    'no unsharded full browser suite may remain',
  );
});
