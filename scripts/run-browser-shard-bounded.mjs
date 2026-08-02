#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  BROWSER_TEST_PORT_VARIABLE,
  BROWSER_TEST_SAMPLE_PORT_VARIABLE,
  isBrowserBlockedPort,
  resolveBrowserTestPorts,
} from './browser-test-ports.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const PLAYWRIGHT_CLI = fileURLToPath(
  import.meta.resolve('@playwright/test/cli')
);
const SHARD_PATTERN = /^(?<current>[1-9][0-9]*)\/(?<total>[1-9][0-9]*)$/;
const PROJECT_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

// A process per whole shard retained native GPU state long enough to degrade
// hosted macOS Firefox. A process per file fixed that but exhausted WinSock
// resources late in 41-file Windows shards. File count alone is not a lifetime
// bound: one six-file group can contain 74 tests while another contains 12.
// Bound every ordinary lifetime dimension: no browser owns more than six files
// or forty tests. A small number of tests deliberately exercise repeated native
// GPU allocation/rollback generations; vulnerable hosted native GPU processes
// must run each containing file in its own process because they retain enough
// state to crash the next unrelated page. A browser-process boundary alone is
// not a host-GPU boundary: hosted macOS Firefox can retain degraded GPU-service
// state after the stressing Firefox process exits. Vulnerable runtimes therefore
// run all ordinary conformance batches first and quarantine declared stress
// files in singleton processes at the tail, where retained driver state cannot
// poison an unrelated test. Even with those declared isolation boundaries, no
// shard may launch more than nine browsers. A growing inventory must add another
// CI shard (or split an oversized spec) instead of silently weakening a resource
// fence.
export const MAX_FILES_PER_BROWSER_PROCESS = 6;
export const MAX_TESTS_PER_BROWSER_PROCESS = 40;
export const MAX_ORDINARY_BROWSER_PROCESSES_PER_SHARD = 8;
export const MAX_BROWSER_PROCESSES_PER_SHARD = 9;
// Playwright requires `@browser-process-intensive` at declaration time and its
// JSON reporter publishes the normalized tag without the leading `@`.
export const PROCESS_INTENSIVE_REPORT_TAG = 'browser-process-intensive';

function readOption(argument, name) {
  const prefix = `--${name}=`;
  return argument.startsWith(prefix) ? argument.slice(prefix.length) : null;
}

/**
 * Parse the deliberately small public surface used by CI.
 *
 * @param {string[]} arguments_
 * @returns {Readonly<{project: string, shard: string, headed: boolean}>}
 */
export function parseBoundedShardArguments(arguments_) {
  let project = null;
  let shard = null;
  let headed = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const projectValue = readOption(argument, 'project');
    const shardValue = readOption(argument, 'shard');

    if (projectValue !== null) {
      if (project !== null) throw new TypeError('--project may be supplied once.');
      project = projectValue;
      continue;
    }
    if (shardValue !== null) {
      if (shard !== null) throw new TypeError('--shard may be supplied once.');
      shard = shardValue;
      continue;
    }
    if (argument === '--headed') {
      if (headed) throw new TypeError('--headed may be supplied once.');
      headed = true;
      continue;
    }
    if (argument === '--project' || argument === '--shard') {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new TypeError(`${argument} requires a value.`);
      }
      if (argument === '--project') {
        if (project !== null) throw new TypeError('--project may be supplied once.');
        project = value;
      } else {
        if (shard !== null) throw new TypeError('--shard may be supplied once.');
        shard = value;
      }
      index += 1;
      continue;
    }
    throw new TypeError(`Unknown bounded browser-shard option: ${argument}`);
  }

  if (!project || !PROJECT_PATTERN.test(project)) {
    throw new TypeError(
      '--project must name one Playwright project using letters, digits, _ or -.'
    );
  }
  const shardMatch = shard?.match(SHARD_PATTERN);
  if (!shardMatch) {
    throw new TypeError('--shard must use the positive-integer form N/M.');
  }
  const current = Number(shardMatch.groups.current);
  const total = Number(shardMatch.groups.total);
  if (!Number.isSafeInteger(current) || !Number.isSafeInteger(total)) {
    throw new RangeError('--shard values must be safe positive integers.');
  }
  if (current > total) {
    throw new RangeError(
      `--shard numerator ${current} cannot exceed denominator ${total}.`
    );
  }

  return Object.freeze({ project, shard: `${current}/${total}`, headed });
}

function environmentWithoutForcedColour(environment) {
  const childEnvironment = { ...environment, NO_COLOR: '1' };
  delete childEnvironment.FORCE_COLOR;
  return childEnvironment;
}

function describeFailedProcess(result, operation) {
  if (result.error) {
    return `${operation} could not start: ${result.error.message}`;
  }
  const termination = result.signal
    ? `signal ${result.signal}`
    : `exit code ${result.status}`;
  const output = [result.stdout, result.stderr]
    .filter(value => typeof value === 'string' && value.trim() !== '')
    .join('\n');
  return output === ''
    ? `${operation} failed with ${termination}.`
    : `${operation} failed with ${termination}:\n${output}`;
}

function listShard(project, shard, headed, environment) {
  const result = spawnSync(
    process.execPath,
    [
      PLAYWRIGHT_CLI,
      'test',
      '--list',
      '--reporter=json',
      `--project=${project}`,
      `--shard=${shard}`,
      ...(headed ? ['--headed'] : []),
    ],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      env: environmentWithoutForcedColour(environment),
      maxBuffer: MAX_CAPTURE_BYTES,
    }
  );
  if (result.error || result.status !== 0) {
    throw new Error(describeFailedProcess(result, 'Playwright shard discovery'));
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new SyntaxError(
      `Playwright shard discovery did not return JSON: ${error.message}`
    );
  }
}

function collectSuiteSpecs(suites, specs) {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) {
      specs.push(spec);
    }
    collectSuiteSpecs(suite.suites, specs);
  }
}

function repositoryRelativeTestFile(testDirectory, file) {
  const absoluteFile = isAbsolute(file) ? resolve(file) : resolve(testDirectory, file);
  const relativeFile = relative(REPOSITORY_ROOT, absoluteFile);
  if (
    relativeFile === '..' ||
    relativeFile.startsWith(`..${sep}`) ||
    isAbsolute(relativeFile)
  ) {
    throw new RangeError(
      `Playwright shard file is outside the repository: ${absoluteFile}`
    );
  }
  return relativeFile.split(sep).join('/');
}

/**
 * Recover the exact weighted file inventory Playwright assigned to one shard.
 * `fullyParallel` is false, so files are the indivisible shard owners and can
 * be replayed independently without dropping or duplicating a test. Test count
 * is retained because file count alone does not bound browser-process lifetime.
 *
 * @param {object} report
 * @param {string} project
 * @returns {ReadonlyArray<Readonly<{
 *   file: string,
 *   intensive: boolean,
 *   tests: number,
 * }>>}
 */
export function extractBoundedShardInventory(report, project) {
  if (!report || typeof report !== 'object') {
    throw new TypeError('Playwright shard report must be an object.');
  }
  if (Array.isArray(report.errors) && report.errors.length > 0) {
    throw new Error(
      `Playwright shard discovery reported ${report.errors.length} error(s).`
    );
  }
  const projectConfig = report.config?.projects?.find(
    candidate => candidate?.name === project
  );
  if (!projectConfig || typeof projectConfig.testDir !== 'string') {
    throw new Error(`Playwright project ${project} has no resolved testDir.`);
  }

  const listedSpecs = [];
  collectSuiteSpecs(report.suites, listedSpecs);
  if (listedSpecs.length === 0) {
    throw new Error(`Playwright assigned no files to ${project} shard.`);
  }

  const inventoryByFile = new Map();
  for (const spec of listedSpecs) {
    if (
      spec === null ||
      typeof spec !== 'object' ||
      typeof spec.file !== 'string' ||
      spec.file === '' ||
      !Array.isArray(spec.tags) ||
      spec.tags.some(tag => typeof tag !== 'string') ||
      !Array.isArray(spec.tests) ||
      spec.tests.length === 0
    ) {
      throw new TypeError(
        'Every Playwright shard spec must publish string tags, a file, and at least one test.'
      );
    }
    if (
      spec.tests.some(
        test => test === null ||
          typeof test !== 'object' ||
          test.projectName !== project
      )
    ) {
      throw new Error(
        `Playwright shard discovery mixed projects inside ${project}.`
      );
    }
    const file = repositoryRelativeTestFile(
      projectConfig.testDir,
      spec.file
    );
    const previous = inventoryByFile.get(file) ?? {
      intensive: false,
      tests: 0,
    };
    const nextCount = previous.tests + spec.tests.length;
    if (!Number.isSafeInteger(nextCount)) {
      throw new RangeError(`Playwright test count overflowed for ${file}.`);
    }
    inventoryByFile.set(file, {
      intensive:
        previous.intensive ||
        spec.tags.includes(PROCESS_INTENSIVE_REPORT_TAG),
      tests: nextCount,
    });
  }
  return Object.freeze(
    Array.from(
      inventoryByFile,
      ([file, { intensive, tests }]) =>
        Object.freeze({ file, intensive, tests })
    )
  );
}

/**
 * Linux WebKit and macOS Firefox are the hosted implementations observed
 * retaining native GPU state across otherwise fully retired pages. Keep the
 * workload declaration in the specs engine-neutral, then apply its extra
 * process boundary only to those exact implementations; other cells retain
 * their proven process plan.
 *
 * @param {string} project
 * @param {Record<string, string | undefined>} environment
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean}
 */
export function shouldIsolateProcessIntensiveFiles(
  project,
  environment,
  platform = process.platform
) {
  if (typeof project !== 'string' || !PROJECT_PATTERN.test(project)) {
    throw new TypeError('Browser isolation project name is invalid.');
  }
  if (environment === null || typeof environment !== 'object') {
    throw new TypeError('Browser isolation environment must be an object.');
  }
  const runnerOs = environment.RUNNER_OS;
  if (runnerOs !== undefined && typeof runnerOs !== 'string') {
    throw new TypeError('RUNNER_OS must be a string when supplied.');
  }
  const linux = runnerOs === undefined
    ? platform === 'linux'
    : runnerOs === 'Linux';
  const macos = runnerOs === undefined
    ? platform === 'darwin'
    : runnerOs === 'macOS';
  return (
    (project === 'webkit' && linux) ||
    (project === 'firefox' && macos)
  );
}

/**
 * Partition one exact Playwright shard without allowing file count, test
 * weight, or process churn to become unbounded. Vulnerable native-GPU runs
 * preserve relative order inside the ordinary and intensive inventories but
 * quarantine every intensive singleton after all ordinary batches. A stress
 * process may outlive Firefox in a shared host GPU service, so process isolation
 * without tail quarantine is not an isolation boundary for later tests.
 *
 * @param {Array<{file: string, intensive: boolean, tests: number}>} inventory
 * @param {boolean} [isolateProcessIntensiveFiles]
 * @returns {ReadonlyArray<Readonly<{
 *   files: ReadonlyArray<string>,
 *   testCount: number,
 * }>>}
 */
export function partitionBrowserShardInventory(
  inventory,
  isolateProcessIntensiveFiles = false
) {
  if (!Array.isArray(inventory) || inventory.length === 0) {
    throw new TypeError(
      'Bounded browser shard inventory must be a non-empty array.'
    );
  }
  if (typeof isolateProcessIntensiveFiles !== 'boolean') {
    throw new TypeError(
      'Process-intensive browser isolation must be a boolean.'
    );
  }
  for (const item of inventory) {
    const itemKeys = item !== null && typeof item === 'object'
      ? Reflect.ownKeys(item)
      : [];
    if (
      item === null ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.getPrototypeOf(item) !== Object.prototype ||
      itemKeys.length !== 3 ||
      !itemKeys.includes('file') ||
      !itemKeys.includes('intensive') ||
      !itemKeys.includes('tests') ||
      itemKeys.some(key => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        return descriptor === undefined ||
          descriptor.enumerable !== true ||
          !Object.hasOwn(descriptor, 'value');
      }) ||
      typeof item.file !== 'string' ||
      item.file === '' ||
      typeof item.intensive !== 'boolean' ||
      !Number.isSafeInteger(item.tests) ||
      item.tests < 1
    ) {
      throw new TypeError(
        'Every bounded browser shard item must contain one file, one intensive flag, and a positive safe test count.'
      );
    }
    if (item.tests > MAX_TESTS_PER_BROWSER_PROCESS) {
      throw new RangeError(
        `${item.file} owns ${item.tests} tests, exceeding the per-process ` +
          `maximum of ${MAX_TESTS_PER_BROWSER_PROCESS}; split the spec file.`,
      );
    }
  }
  const files = inventory.map(item => item.file);
  if (new Set(files).size !== inventory.length) {
    throw new TypeError('Bounded browser shard files must be unique.');
  }

  const hasIntensiveIsolation =
    isolateProcessIntensiveFiles &&
    inventory.some(item => item.intensive);
  const processCapacity = hasIntensiveIsolation
    ? MAX_BROWSER_PROCESSES_PER_SHARD
    : MAX_ORDINARY_BROWSER_PROCESSES_PER_SHARD;
  const fileCapacity = MAX_FILES_PER_BROWSER_PROCESS * processCapacity;
  if (inventory.length > fileCapacity) {
    throw new RangeError(
      `Browser shard assigns ${inventory.length} files, exceeding the bounded ` +
        `capacity of ${fileCapacity}; increase the CI shard count.`,
    );
  }

  const batches = [];
  let batchFiles = [];
  let batchTestCount = 0;
  const publishBatch = () => {
    if (batchFiles.length === 0) return;
    batches.push(Object.freeze({
      files: Object.freeze(batchFiles),
      testCount: batchTestCount,
    }));
    batchFiles = [];
    batchTestCount = 0;
  };
  const ordinaryInventory = isolateProcessIntensiveFiles
    ? inventory.filter(item => !item.intensive)
    : inventory;
  const intensiveInventory = isolateProcessIntensiveFiles
    ? inventory.filter(item => item.intensive)
    : [];
  for (const item of ordinaryInventory) {
    if (
      batchFiles.length === MAX_FILES_PER_BROWSER_PROCESS ||
      (
        batchFiles.length > 0 &&
        batchTestCount + item.tests > MAX_TESTS_PER_BROWSER_PROCESS
      )
    ) {
      publishBatch();
    }
    batchFiles.push(item.file);
    batchTestCount += item.tests;
  }
  publishBatch();
  for (const item of intensiveInventory) {
    batchFiles.push(item.file);
    batchTestCount = item.tests;
    publishBatch();
  }
  if (batches.length > processCapacity) {
    throw new RangeError(
      `Browser shard requires ${batches.length} bounded processes, exceeding ` +
        `the maximum of ${processCapacity}; increase the CI ` +
        `shard count.`,
    );
  }
  return Object.freeze(batches);
}

/**
 * Give every bounded child process its own server pair and therefore its own
 * Playwright output directory. A failed batch's evidence cannot be overwritten
 * by a later batch, and a failed server teardown cannot strand the next one.
 *
 * @param {Record<string, string | undefined>} environment
 * @param {number} batchCount
 * @returns {ReadonlyArray<Readonly<{port: number, samplePort: number}>>}
 */
export function planBrowserBatchPorts(environment, batchCount) {
  if (!Number.isInteger(batchCount) || batchCount < 1) {
    throw new RangeError('Bounded browser shard batchCount must be positive.');
  }
  if (batchCount > MAX_BROWSER_PROCESSES_PER_SHARD) {
    throw new RangeError(
      `Bounded browser shard cannot launch ${batchCount} processes; maximum ` +
        `is ${MAX_BROWSER_PROCESSES_PER_SHARD}.`,
    );
  }
  const { port, samplePort } = resolveBrowserTestPorts(environment);
  const stride = Math.abs(samplePort - port) + 1;
  const plan = [];
  let candidateIndex = 0;
  while (plan.length < batchCount) {
    const candidate = Object.freeze({
      port: port + stride * candidateIndex,
      samplePort: samplePort + stride * candidateIndex,
    });
    candidateIndex += 1;
    if (candidate.port > 65535 || candidate.samplePort > 65535) {
      throw new RangeError(
        'Bounded browser shard cannot allocate one valid port pair per batch.'
      );
    }
    // Binding a Fetch-blocked port succeeds, but every browser navigation to
    // it fails. Skip the whole pair so neither the application nor CORS sample
    // origin can silently become unreachable as a shard grows.
    if (
      isBrowserBlockedPort(candidate.port) ||
      isBrowserBlockedPort(candidate.samplePort)
    ) {
      continue;
    }
    plan.push(candidate);
  }
  return Object.freeze(plan);
}

function runBatch(project, files, ports, headed, environment) {
  const childEnvironment = {
    ...environmentWithoutForcedColour(environment),
    [BROWSER_TEST_PORT_VARIABLE]: String(ports.port),
    [BROWSER_TEST_SAMPLE_PORT_VARIABLE]: String(ports.samplePort),
  };
  return spawnSync(
    process.execPath,
    [
      PLAYWRIGHT_CLI,
      'test',
      `--project=${project}`,
      ...(headed ? ['--headed'] : []),
      ...files,
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: childEnvironment,
      stdio: 'inherit',
    }
  );
}

export function runBoundedBrowserShard(
  { project, shard, headed },
  environment
) {
  const report = listShard(project, shard, headed, environment);
  const inventory = extractBoundedShardInventory(report, project);
  const isolateProcessIntensiveFiles =
    shouldIsolateProcessIntensiveFiles(project, environment) &&
    inventory.some(item => item.intensive);
  const batches = partitionBrowserShardInventory(
    inventory,
    isolateProcessIntensiveFiles
  );
  const portPlan = planBrowserBatchPorts(environment, batches.length);
  const fileCount = inventory.length;
  const testCount = inventory.reduce((total, item) => total + item.tests, 0);
  const failures = [];

  console.log(
    `Running ${project} shard ${shard}: ${fileCount} files and ` +
      `${testCount} tests in ` +
      `${batches.length} bounded browser processes` +
      `${isolateProcessIntensiveFiles
        ? ' with tail-quarantined native-GPU isolation'
        : ''}.`,
  );
  batches.forEach((batch, index) => {
    console.log(
      `\n[bounded ${index + 1}/${batches.length}: ` +
        `${batch.testCount} tests]\n` +
        batch.files.map(file => `  ${file}`).join('\n'),
    );
    const result = runBatch(
      project,
      batch.files,
      portPlan[index],
      headed,
      environment
    );
    if (result.error || result.status !== 0) {
      failures.push({
        files: batch.files,
        termination: result.error?.message ?? result.signal ?? result.status,
      });
    }
  });

  if (failures.length > 0) {
    const details = failures
      .map(failure =>
        `  - ${failure.files.join(', ')} (${failure.termination})`
      )
      .join('\n');
    throw new Error(
      `${failures.length} bounded browser batch(es) failed:\n${details}`
    );
  }
  console.log(
    `Completed all ${fileCount} files and ${testCount} tests in ${project} ` +
      `shard ${shard} ` +
      `across ${batches.length} bounded browser processes.`,
  );
}

function main() {
  const options = parseBoundedShardArguments(process.argv.slice(2));
  runBoundedBrowserShard(options, process.env);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
