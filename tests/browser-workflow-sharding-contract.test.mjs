import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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

test('the walk\'s shares hold every part exactly once, and are filled by weight', async () => {
  const { LEFT_OUT, PARTS, WALK_TESTS, readWalkWeights, walkShares } = await import('./browser/helpers/control-walk-parts.mjs');
  const [page, walkFiles] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readdir(new URL('./browser/', import.meta.url)),
  ]);
  const shares = walkFiles.filter(file => /^control-walk-\d+-of-\d+\.spec\.mjs$/.test(file)).length;

  // Every section of the page is a part, or is left out whole with a reason.
  const sections = [...page.matchAll(/<details class="accordion-section"[^>]*\bid="([^"]+)"/g)].map(match => match[1]);
  assert.ok(sections.length > 0, 'the page has sidebar sections');
  for (const section of sections) {
    const leftOut = LEFT_OUT.some(item => item.place === section && item.namePrefix === undefined && item.why);
    assert.ok(PARTS.includes(section) !== leftOut, `${section} is a part of the walk, or is left out whole with a reason`);
  }
  for (const part of PARTS) assert.ok(WALK_TESTS.includes(part), `${part} is a test of the walk`);

  /**
   * Each name is in exactly one share, and the shares hold as many tests as
   * each other (the first ones one more): the numbers in which Playwright's
   * `--shard`, which splits by test count, gives each file a shard of its own.
   */
  const assertPartition = (split, names, what) => {
    assert.deepEqual(split.flat().sort(), [...names].sort(), `${what}: every test is in exactly one share`);
    assert.deepEqual(
      split.map(share => share.length),
      Array.from({ length: shares }, (_, share) => Math.floor(names.length / shares) + (share < names.length % shares ? 1 : 0)),
      `${what}: a share for each spec file, as many tests in each`,
    );
  };
  const weights = readWalkWeights();
  const split = walkShares(WALK_TESTS, weights, shares);
  assertPartition(split, WALK_TESTS, 'the walk as recorded');

  // By weight: the heaviest tests, one for each share, are each in another.
  const recorded = WALK_TESTS.filter(name => Number.isInteger(weights[name]));
  assert.ok(recorded.length >= shares, 'the record (control-walk-weights.json) holds the walk\'s tests');
  const heaviest = [...recorded].sort((a, b) => weights[b] - weights[a]).slice(0, shares);
  assert.equal(
    new Set(heaviest.map(name => split.findIndex(share => share.includes(name)))).size,
    shares,
    `${heaviest.join(', ')} are each in a share of their own`,
  );

  // A record behind the page costs balance only: a new part, a part gone
  // and no record at all each leave every test in exactly one share.
  const grown = [...WALK_TESTS, 'a-new-section'];
  assertPartition(walkShares(grown, weights, shares), grown, 'a part the record does not name');
  assertPartition(walkShares(WALK_TESTS, { ...weights, 'a-section-gone': 900 }, shares), WALK_TESTS, 'a record naming a part that is gone');
  assertPartition(walkShares(WALK_TESTS, {}, shares), WALK_TESTS, 'no record');
});

/** The browser specs that name an interpreter of the real Python or R package (`helpers/viewer-interpreters.mjs`), and the variables they name. */
async function viewerSpecs() {
  const files = (await readdir(new URL('./browser/', import.meta.url))).filter(file => file.endsWith('.spec.mjs')).sort();
  const sources = await Promise.all(files.map(file => readFile(new URL(`./browser/${file}`, import.meta.url), 'utf8')));
  const named = files.map((file, index) => ({ file: `tests/browser/${file}`, variables: [...sources[index].matchAll(/\bviewerInterpreter\('([A-Z_]+)'/g)].map(match => match[1]) }))
    .filter(spec => spec.variables.length > 0);
  return { specs: named.map(spec => spec.file), variables: [...new Set(named.flatMap(spec => spec.variables))].sort() };
}

test('the viewer specs run in CI against the real packages, with every interpreter they ask for named and required', async () => {
  const [workflow, { specs, variables }] = await Promise.all([
    readFile(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8'),
    viewerSpecs(),
  ]);
  assert.ok(specs.length > 0, 'some specs run the viewer against the real packages');

  // A spec that skips where it is the gate checks nothing: each is named in the
  // workflow (the sharded jobs run every spec, and skip these), and every
  // interpreter variable any of them reads is set there, with the viewers required.
  for (const spec of specs) assert.ok(workflow.includes(spec), `${spec} runs in CI`);
  for (const variable of variables) assert.match(workflow, new RegExp(`(?<![A-Z_])${variable}=`), `${variable} is set for the specs`);
  assert.ok(workflow.includes('CELLUCID_REQUIRE_VIEWERS: "1"'), 'a missing interpreter is a failure in CI');

  // Every test file the workflow names exists.
  const named = [...new Set(workflow.match(/\btests\/[\w./-]+\.(?:mjs|js)\b/g))];
  const missing = named.filter(file => !existsSync(new URL(`../${file}`, import.meta.url)));
  assert.deepEqual(missing, [], 'test files the workflow runs that are not in the repository');

  // The job that has the packages runs exactly those specs, whole (no shard, no retry: a retried
  // viewer spec would hide an intermittent defect), and every contract that asks for the viewers.
  const { readWorkflow } = await import('./helpers/workflow.mjs');
  const runs = Object.values(readWorkflow('test.yml').jobs)
    .filter(job => Object.hasOwn(job.env ?? {}, 'CELLUCID_REQUIRE_VIEWERS'))
    .flatMap(job => job.steps.map(step => String(step.run ?? '')));
  const browserRuns = runs.filter(run => /\bnpm run test:browser\b/.test(run));
  assert.equal(browserRuns.length, 1, 'the viewer job makes one browser run');
  const ran = browserRuns[0].match(/\btests\/browser\/[\w.-]+\.spec\.mjs\b/g) ?? [];
  assert.deepEqual([...ran].sort(), specs, 'the viewer job runs exactly the specs that ask for an interpreter');
  assert.doesNotMatch(browserRuns[0], /--shard|--retries/, 'the viewer specs run whole, never retried');
  const contracts = (await readdir(new URL('./', import.meta.url))).filter(file => file.endsWith('.test.mjs') && file !== 'browser-workflow-sharding-contract.test.mjs');
  for (const file of contracts) {
    if (!/CELLUCID_REQUIRE_VIEWERS/.test(await readFile(new URL(`./${file}`, import.meta.url), 'utf8'))) continue;
    assert.ok(runs.some(run => new RegExp(`node --test\\b[^\\n]*\\btests/${file.replace(/\./g, '\\.')}`).test(run)), `the viewer job runs tests/${file}`);
  }
});

test('an interpreter that is not named is a skip, and a failure where the viewers are required', async () => {
  const { viewerInterpreter } = await import('./browser/helpers/viewer-interpreters.mjs');
  assert.equal(viewerInterpreter('CELLUCID_PYTHON', {}), null);
  assert.equal(viewerInterpreter('CELLUCID_PYTHON', { CELLUCID_PYTHON: '/usr/bin/python3' }), '/usr/bin/python3');
  assert.equal(viewerInterpreter('CELLUCID_RSCRIPT', { CELLUCID_REQUIRE_VIEWERS: '1', CELLUCID_RSCRIPT: '/usr/bin/Rscript' }), '/usr/bin/Rscript');
  assert.throws(
    () => viewerInterpreter('CELLUCID_RSCRIPT', { CELLUCID_REQUIRE_VIEWERS: '1', CELLUCID_PYTHON: '/usr/bin/python3' }),
    /CELLUCID_RSCRIPT names no interpreter/,
  );
});
