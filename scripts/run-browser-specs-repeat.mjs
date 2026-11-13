#!/usr/bin/env node

// Run browser specs many times in every engine, so a race shows here rather
// than as a red CI cell on someone else's push.
//
//   npm run test:browser:repeat -- [spec or helper …] [--repeat=N]
//                                  [--project=<engine> …] [--grep=<pattern>]
//
// Each engine runs every chosen spec N times (default 5), one engine after
// another, with one worker and no retries, as CI runs them. The command fails
// if any single run of any test fails, and prints each engine's passed and
// failed runs and the tests that failed.
//
// A browser process lives as long as CI lets it (`planRepeatBatches`, the
// bounded runner's files and tests a process): a WebKit that runs on past its
// fortieth test can stop answering a new page's first navigation, a failure
// no CI cell can have.
//
// Without paths it runs the specs changed relative to `origin/main` (committed
// and uncommitted, and untracked files) and every spec that imports a changed
// helper of `tests/browser/`, directly or through another helper. A helper
// path given explicitly stands for the specs that import it.
//
// Ports come from the bounded runner's planner, so a run beside another
// browser-test run takes a free pair rather than colliding with it.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  BROWSER_TEST_PORT_VARIABLE,
  BROWSER_TEST_SAMPLE_PORT_VARIABLE,
} from './browser-test-ports.mjs';
import {
  PLAYWRIGHT_CLI,
  environmentWithoutForcedColor,
  extractBoundedShardInventory,
  planBrowserBatchPorts,
  resolveBrowserShardLimits,
} from './run-browser-shard-bounded.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BROWSER_TESTS = 'tests/browser/';
const ENGINES = Object.freeze(['chromium', 'firefox', 'webkit']);
const DEFAULT_REPEAT = 5;
const BASE_REF = 'origin/main';
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

const USAGE =
  'Usage: npm run test:browser:repeat -- [spec or helper path …] ' +
  '[--repeat=N] [--project=<engine> …] [--grep=<pattern>]';

/**
 * @param {string[]} arguments_
 * @returns {Readonly<{paths: string[], repeat: number, projects: string[], grep: string | null}>}
 */
export function parseRepeatArguments(arguments_) {
  const paths = [];
  const projects = [];
  let repeat = null;
  let grep = null;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const match = /^--(repeat|project|grep)(?:=(.*))?$/s.exec(argument);
    if (match === null) {
      if (argument.startsWith('--')) {
        throw new TypeError(`Unknown option ${argument}. ${USAGE}`);
      }
      paths.push(argument);
      continue;
    }
    const [, name, inline] = match;
    let value = inline;
    if (value === undefined) {
      value = arguments_[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new TypeError(`--${name} requires a value. ${USAGE}`);
      }
      index += 1;
    }
    if (name === 'repeat') {
      if (repeat !== null) throw new TypeError('--repeat may be supplied once.');
      if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new RangeError(`--repeat must be a positive whole number; received ${JSON.stringify(value)}.`);
      }
      repeat = Number(value);
    } else if (name === 'project') {
      if (!ENGINES.includes(value)) {
        throw new RangeError(`--project must be one of ${ENGINES.join(', ')}; received ${JSON.stringify(value)}.`);
      }
      if (projects.includes(value)) throw new TypeError(`--project=${value} is given twice.`);
      projects.push(value);
    } else {
      if (grep !== null) throw new TypeError('--grep may be supplied once.');
      if (value === '') throw new TypeError('--grep must not be empty.');
      grep = value;
    }
  }

  return Object.freeze({
    paths,
    repeat: repeat ?? DEFAULT_REPEAT,
    // CI's order, so a repeated run reads like a CI matrix row.
    projects: projects.length > 0 ? ENGINES.filter(engine => projects.includes(engine)) : [...ENGINES],
    grep,
  });
}

const IMPORT_SPECIFIERS = [
  /\bfrom\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];

function listModules(directory) {
  const modules = [];
  for (const entry of readdirSync(path.join(REPOSITORY_ROOT, directory), { withFileTypes: true })) {
    const relative = `${directory}${entry.name}`;
    if (entry.isDirectory()) modules.push(...listModules(`${relative}/`));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) modules.push(relative);
  }
  return modules;
}

/**
 * Which modules of `tests/browser/` import each one, from their relative
 * import specifiers (static, re-exports and dynamic `import('…')`).
 *
 * @param {Record<string, string>} sources - repository-relative path -> source
 * @returns {Map<string, Set<string>>} imported path -> importing paths
 */
export function browserTestImporters(sources) {
  const importers = new Map();
  for (const [file, source] of Object.entries(sources)) {
    for (const pattern of IMPORT_SPECIFIERS) {
      for (const [, specifier] of source.matchAll(pattern)) {
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
        const imported = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
        if (!importers.has(imported)) importers.set(imported, new Set());
        importers.get(imported).add(file);
      }
    }
  }
  return importers;
}

/**
 * The specs that run for a set of `tests/browser/` paths: a spec itself, and
 * for any other module every spec that imports it, directly or through other
 * modules. A path that leads to no spec (a fixture) is returned as unmapped.
 *
 * @param {string[]} files - repository-relative paths under tests/browser/
 * @param {Map<string, Set<string>>} importers
 * @returns {{specs: Map<string, string>, unmapped: string[]}} spec -> why it runs
 */
export function specsForChangedFiles(files, importers) {
  const specs = new Map();
  const unmapped = [];
  for (const file of files) {
    if (file.endsWith('.spec.mjs')) {
      if (!specs.has(file)) specs.set(file, 'changed');
      continue;
    }
    const seen = new Set([file]);
    const queue = [file];
    let reached = 0;
    while (queue.length > 0) {
      for (const importer of importers.get(queue.shift()) ?? []) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        if (importer.endsWith('.spec.mjs')) {
          reached += 1;
          if (!specs.has(importer)) specs.set(importer, `imports ${file}`);
        } else {
          queue.push(importer);
        }
      }
    }
    if (reached === 0) unmapped.push(file);
  }
  return { specs, unmapped };
}

function git(arguments_) {
  const result = spawnSync('git', arguments_, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: MAX_CAPTURE_BYTES,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `git ${arguments_.join(' ')} failed: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  return result.stdout.split('\n').filter(line => line !== '');
}

function changedBrowserTestFiles() {
  return [...new Set([
    ...git(['diff', '--name-only', BASE_REF, '--', BROWSER_TESTS]),
    ...git(['ls-files', '--others', '--exclude-standard', '--', BROWSER_TESTS]),
  ])].sort();
}

function repositoryPath(argument) {
  const absolute = path.resolve(process.cwd(), argument);
  const relative = path.relative(REPOSITORY_ROOT, absolute).split(path.sep).join('/');
  if (!relative.startsWith(BROWSER_TESTS) || !relative.endsWith('.mjs')) {
    throw new RangeError(`${argument} is not a module under ${BROWSER_TESTS}.`);
  }
  if (!existsSync(absolute)) throw new RangeError(`${argument} does not exist.`);
  return relative;
}

export function chooseSpecs(paths) {
  const modules = listModules(BROWSER_TESTS);
  const importers = browserTestImporters(Object.fromEntries(
    modules.map(file => [file, readFileSync(path.join(REPOSITORY_ROOT, file), 'utf8')]),
  ));
  const named = paths.length > 0;
  const files = named ? paths.map(repositoryPath) : changedBrowserTestFiles();
  const { specs, unmapped } = specsForChangedFiles(files, importers);
  // A spec deleted on this branch has nothing left to run.
  for (const spec of specs.keys()) {
    if (!existsSync(path.join(REPOSITORY_ROOT, spec))) specs.delete(spec);
  }
  return { named, specs, unmapped };
}

function collectSpecs(suites, titles, found, testFile) {
  for (const suite of suites ?? []) {
    // A file's suite is titled by its path; describe blocks by their titles.
    const path_ = suite.title === suite.file ? titles : [...titles, suite.title];
    // The top-level suite is the test file. A spec's own `file` is where its
    // `test()` call stands: a helper module when the file declares its tests
    // through one (`control-walk-<k>-of-<n>.spec.mjs`), which names no file to
    // run and is shared by every file that declares through it.
    const file = testFile ?? suite.file;
    for (const spec of suite.specs ?? []) found.push({ spec, titles: path_, file });
    collectSpecs(suite.suites, path_, found, file);
  }
}

/**
 * Passed, failed and skipped runs of one engine's JSON report, and each test
 * that failed in any run with how many of its runs failed.
 *
 * @param {object} report - Playwright's JSON report
 * @returns {{passed: number, failed: number, skipped: number,
 *   failures: Array<{id: string, failed: number, runs: number}>, errors: string[]}}
 */
export function summarizeRepeatReport(report) {
  const found = [];
  collectSpecs(report?.suites, [], found);
  const byTest = new Map();
  const totals = { passed: 0, failed: 0, skipped: 0 };
  for (const { spec, titles, file } of found) {
    const where = spec.file === file ? `${file}:${spec.line}` : `${file} (${spec.file}:${spec.line})`;
    const id = `${BROWSER_TESTS}${where} › ${[...titles, spec.title].join(' › ')}`;
    const counts = byTest.get(id) ?? { failed: 0, runs: 0 };
    for (const run of spec.tests ?? []) {
      counts.runs += 1;
      if (run.status === 'skipped') totals.skipped += 1;
      else if (run.status === 'expected') totals.passed += 1;
      else {
        totals.failed += 1;
        counts.failed += 1;
      }
    }
    byTest.set(id, counts);
  }
  return {
    ...totals,
    failures: [...byTest]
      .filter(([, counts]) => counts.failed > 0)
      .map(([id, counts]) => ({ id, ...counts })),
    errors: (report?.errors ?? []).map(error => error.message ?? String(error)),
  };
}

/**
 * The Playwright processes that run every file of `inventory` `repeat` times
 * without any browser outliving CI's bounds: files grouped up to the files
 * and tests of a process, in order, and each group repeated in as many
 * processes as its tests allow (`repeatEach` runs of its files in each). A
 * file above the tests of a process runs alone, one repetition a process.
 *
 * @param {ReadonlyArray<{file: string, tests: number}>} inventory
 * @param {number} repeat
 * @param {{maxFilesPerProcess: number, maxTestsPerProcess: number}} limits
 * @returns {Array<{files: string[], repeatEach: number}>}
 */
export function planRepeatBatches(inventory, repeat, { maxFilesPerProcess, maxTestsPerProcess }) {
  const groups = [];
  for (const { file, tests } of inventory) {
    const group = groups.at(-1);
    if (group !== undefined && group.files.length < maxFilesPerProcess && group.tests + tests <= maxTestsPerProcess) {
      group.files.push(file);
      group.tests += tests;
    } else {
      groups.push({ files: [file], tests });
    }
  }
  const batches = [];
  for (const { files, tests } of groups) {
    const most = Math.max(1, Math.floor(maxTestsPerProcess / tests));
    for (let left = repeat; left > 0; left -= most) {
      batches.push({ files, repeatEach: Math.min(left, most) });
    }
  }
  return batches;
}

/** Add one process's summary to an engine's. */
export function addRepeatSummary(total, summary) {
  const failures = new Map(total.failures.map(failure => [failure.id, { ...failure }]));
  for (const { id, failed, runs } of summary.failures) {
    const counts = failures.get(id) ?? { id, failed: 0, runs: 0 };
    counts.failed += failed;
    counts.runs += runs;
    failures.set(id, counts);
  }
  return {
    passed: total.passed + summary.passed,
    failed: total.failed + summary.failed,
    skipped: total.skipped + summary.skipped,
    failures: [...failures.values()],
    errors: [...total.errors, ...summary.errors],
  };
}

function testsOfSpecs(project, specs, grep, environment) {
  const result = spawnSync(
    process.execPath,
    [
      PLAYWRIGHT_CLI,
      'test',
      '--list',
      '--reporter=json',
      `--project=${project}`,
      ...(grep === null ? [] : [`--grep=${grep}`]),
      ...specs,
    ],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      env: environmentWithoutForcedColor(environment),
      maxBuffer: MAX_CAPTURE_BYTES,
    },
  );
  let report = null;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    // Reported below.
  }
  if (report === null || result.error || result.status !== 0) {
    const reported = report?.errors?.map(error => error.message ?? String(error)).join('; ');
    throw new Error(`Listing the specs of ${project} failed: ${result.error?.message ?? reported ?? result.stderr}`);
  }
  return extractBoundedShardInventory(report, project);
}

function runBatch(project, { files, repeatEach }, grep, environment, reportFile) {
  const [ports] = planBrowserBatchPorts(environment, 1);
  rmSync(reportFile, { force: true });
  const result = spawnSync(
    process.execPath,
    [
      PLAYWRIGHT_CLI,
      'test',
      `--project=${project}`,
      `--repeat-each=${repeatEach}`,
      '--workers=1',
      '--retries=0',
      '--reporter=line,json',
      ...(grep === null ? [] : [`--grep=${grep}`]),
      ...files,
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: {
        ...environmentWithoutForcedColor(environment),
        [BROWSER_TEST_PORT_VARIABLE]: String(ports.port),
        [BROWSER_TEST_SAMPLE_PORT_VARIABLE]: String(ports.samplePort),
        PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile,
      },
      stdio: 'inherit',
    },
  );
  const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : null;
  const summary = summarizeRepeatReport(report);
  if (report === null) {
    summary.errors.push('Playwright wrote no report.');
  }
  if (result.error || result.status !== 0) {
    if (summary.failed === 0 && summary.errors.length === 0) {
      summary.errors.push(
        `Playwright ended with ${result.error?.message ?? (result.signal ? `signal ${result.signal}` : `exit code ${result.status}`)}.`,
      );
    }
  }
  return summary;
}

function runEngine(project, specs, { repeat, grep }, environment, reportFile) {
  let total = { passed: 0, failed: 0, skipped: 0, failures: [], errors: [] };
  let batches;
  try {
    batches = planRepeatBatches(testsOfSpecs(project, specs, grep, environment), repeat, resolveBrowserShardLimits(environment));
  } catch (error) {
    total.errors.push(error.message);
    return total;
  }
  for (const [index, batch] of batches.entries()) {
    console.log(`[repeat: ${project}, browser process ${index + 1} of ${batches.length}: ${batch.files.length} file(s) × ${batch.repeatEach}]`);
    total = addRepeatSummary(total, runBatch(project, batch, grep, environment, reportFile));
  }
  return total;
}

export function runRepeatedBrowserSpecs(options, environment) {
  const { named, specs, unmapped } = chooseSpecs(options.paths);
  if (specs.size === 0) {
    console.log(
      named
        ? 'No spec imports the named modules.'
        : `No spec under ${BROWSER_TESTS} changed relative to ${BASE_REF}, and no changed helper is imported by one. ` +
          'Name the specs to repeat.',
    );
    if (unmapped.length > 0) console.log(`Changed, not imported by a spec: ${unmapped.join(', ')}`);
    return true;
  }
  const files = [...specs.keys()].sort();
  console.log(
    `Repeating ${files.length} spec file${files.length === 1 ? '' : 's'} ${options.repeat} times in ` +
      `${options.projects.join(', ')}, one engine after another, one worker, no retries` +
      `${options.grep === null ? '' : `, tests matching ${JSON.stringify(options.grep)}`}:\n` +
      files.map(file => `  ${file} (${specs.get(file)})`).join('\n'),
  );
  if (unmapped.length > 0) {
    console.log(`Changed, not imported by any spec: ${unmapped.join(', ')}`);
  }

  const reports = mkdtempSync(path.join(tmpdir(), 'cellucid-browser-repeat-'));
  const summaries = [];
  try {
    for (const project of options.projects) {
      console.log(`\n[repeat: ${project}]`);
      summaries.push([project, runEngine(project, files, options, environment, path.join(reports, `${project}.json`))]);
    }
  } finally {
    rmSync(reports, { recursive: true, force: true });
  }

  console.log('\nRepeated browser specs:');
  let stable = true;
  for (const [project, summary] of summaries) {
    const clean = summary.failed === 0 && summary.errors.length === 0;
    stable &&= clean;
    console.log(
      `  ${clean ? 'ok  ' : 'FAIL'} ${project}: ${summary.passed} passed, ${summary.failed} failed` +
        `${summary.skipped > 0 ? `, ${summary.skipped} skipped` : ''}`,
    );
    for (const failure of summary.failures) {
      console.log(`         ${failure.id} (failed ${failure.failed} of ${failure.runs} runs)`);
    }
    for (const error of summary.errors) console.log(`         ${error}`);
  }
  return stable;
}

function main() {
  const options = parseRepeatArguments(process.argv.slice(2));
  if (!runRepeatedBrowserSpecs(options, process.env)) process.exitCode = 1;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
