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

function readOption(argument, name) {
  const prefix = `--${name}=`;
  return argument.startsWith(prefix) ? argument.slice(prefix.length) : null;
}

/**
 * Parse the deliberately small public surface used by CI.
 *
 * @param {string[]} arguments_
 * @returns {Readonly<{project: string, shard: string}>}
 */
export function parseIsolatedShardArguments(arguments_) {
  let project = null;
  let shard = null;

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
    throw new TypeError(`Unknown isolated browser-shard option: ${argument}`);
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

  return Object.freeze({ project, shard: `${current}/${total}` });
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

function listShard(project, shard, environment) {
  const result = spawnSync(
    process.execPath,
    [
      PLAYWRIGHT_CLI,
      'test',
      '--list',
      '--reporter=json',
      `--project=${project}`,
      `--shard=${shard}`,
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

function collectSuiteFiles(suites, files) {
  for (const suite of suites ?? []) {
    if (typeof suite.file === 'string' && suite.file !== '') {
      files.add(suite.file);
    }
    collectSuiteFiles(suite.suites, files);
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
 * Recover the exact file inventory Playwright assigned to one shard.
 * `fullyParallel` is false, so files are the indivisible shard owners and can
 * be replayed independently without dropping or duplicating a test.
 *
 * @param {object} report
 * @param {string} project
 * @returns {string[]}
 */
export function extractIsolatedShardFiles(report, project) {
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

  const listedFiles = new Set();
  collectSuiteFiles(report.suites, listedFiles);
  if (listedFiles.size === 0) {
    throw new Error(`Playwright assigned no files to ${project} shard.`);
  }

  const relativeFiles = new Set();
  for (const file of listedFiles) {
    relativeFiles.add(repositoryRelativeTestFile(projectConfig.testDir, file));
  }
  return Array.from(relativeFiles);
}

/**
 * Give every child process its own server pair and therefore its own
 * Playwright output directory. A failed file's evidence cannot be overwritten
 * by a later file, and a failed server teardown cannot strand the next batch.
 *
 * @param {Record<string, string | undefined>} environment
 * @param {number} fileCount
 * @returns {ReadonlyArray<Readonly<{port: number, samplePort: number}>>}
 */
export function planIsolatedShardPorts(environment, fileCount) {
  if (!Number.isInteger(fileCount) || fileCount < 1) {
    throw new RangeError('Isolated browser shard fileCount must be positive.');
  }
  const { port, samplePort } = resolveBrowserTestPorts(environment);
  const stride = Math.abs(samplePort - port) + 1;
  const plan = [];
  let candidateIndex = 0;
  while (plan.length < fileCount) {
    const candidate = Object.freeze({
      port: port + stride * candidateIndex,
      samplePort: samplePort + stride * candidateIndex,
    });
    candidateIndex += 1;
    if (candidate.port > 65535 || candidate.samplePort > 65535) {
      throw new RangeError(
        'Isolated browser shard cannot allocate one valid port pair per file.'
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

function runFile(project, file, ports, environment) {
  const childEnvironment = {
    ...environmentWithoutForcedColour(environment),
    [BROWSER_TEST_PORT_VARIABLE]: String(ports.port),
    [BROWSER_TEST_SAMPLE_PORT_VARIABLE]: String(ports.samplePort),
  };
  return spawnSync(
    process.execPath,
    [PLAYWRIGHT_CLI, 'test', `--project=${project}`, file],
    {
      cwd: REPOSITORY_ROOT,
      env: childEnvironment,
      stdio: 'inherit',
    }
  );
}

export function runIsolatedBrowserShard({ project, shard }, environment) {
  const report = listShard(project, shard, environment);
  const files = extractIsolatedShardFiles(report, project);
  const portPlan = planIsolatedShardPorts(environment, files.length);
  const failures = [];

  console.log(
    `Running ${project} shard ${shard} as ${files.length} isolated spec files.`
  );
  files.forEach((file, index) => {
    console.log(`\n[isolated ${index + 1}/${files.length}] ${file}`);
    const result = runFile(project, file, portPlan[index], environment);
    if (result.error || result.status !== 0) {
      failures.push({
        file,
        termination: result.error?.message ?? result.signal ?? result.status,
      });
    }
  });

  if (failures.length > 0) {
    const details = failures
      .map(failure => `  - ${failure.file} (${failure.termination})`)
      .join('\n');
    throw new Error(
      `${failures.length} isolated browser spec file(s) failed:\n${details}`
    );
  }
  console.log(
    `Completed all ${files.length} isolated files in ${project} shard ${shard}.`
  );
}

function main() {
  const options = parseIsolatedShardArguments(process.argv.slice(2));
  runIsolatedBrowserShard(options, process.env);
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
