/**
 * The two short test sets (`scripts/test-suites.mjs`) name files that exist,
 * each once, and are what `npm run test:core` and `npm run
 * test:browser:smoke` run: a renamed or deleted test cannot leave either set
 * silently shorter.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BROWSER_ENGINES,
  BROWSER_SMOKE,
  CORE_CONTRACT_TESTS,
  coreTestFiles,
  smokeSpecs,
} from '../scripts/test-suites.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('every core contract test exists and is listed once, and every layer has one', () => {
  const names = CORE_CONTRACT_TESTS.flatMap(({ files }) => files);
  assert.deepEqual(names.filter((name, index) => names.indexOf(name) !== index), [], 'listed twice');
  assert.deepEqual(names.filter(name => !existsSync(path.join(ROOT, 'tests', `${name}.test.mjs`))), [], 'not in tests/');
  assert.deepEqual(CORE_CONTRACT_TESTS.filter(({ files }) => files.length === 0).map(({ layer }) => layer), [], 'a layer with no test');
  assert.deepEqual(coreTestFiles(), names.map(name => path.join(ROOT, 'tests', `${name}.test.mjs`)));
});

test('every smoke spec exists, and an engine runs none twice', () => {
  assert.deepEqual(Object.keys(BROWSER_SMOKE).sort(), ['every', ...BROWSER_ENGINES].sort());
  for (const engine of BROWSER_ENGINES) {
    const names = [...BROWSER_SMOKE.every, ...BROWSER_SMOKE[engine]];
    assert.deepEqual(names.filter((name, index) => names.indexOf(name) !== index), [], `${engine}: listed twice`);
    assert.deepEqual(names.filter(name => !existsSync(path.join(ROOT, 'tests', 'browser', `${name}.spec.mjs`))), [], `${engine}: not in tests/browser/`);
    assert.deepEqual(smokeSpecs(engine), names.map(name => `**/${name}.spec.mjs`));
  }
  assert.throws(() => smokeSpecs('edge'), /not an engine/);
});

test('the engines are the projects of the Playwright configuration, each given its smoke specs', () => {
  const config = readFileSync(path.join(ROOT, 'playwright.config.mjs'), 'utf8');
  const projects = [...config.matchAll(/^\s+name: '([a-z]+)',\n\s+\.\.\.onlySmoke\('([a-z]+)'\),$/gm)];
  assert.deepEqual(projects.map(match => match[1]), [...BROWSER_ENGINES]);
  assert.deepEqual(projects.map(match => match[2]), [...BROWSER_ENGINES]);
});

test('npm run test:core runs the core list, and --core takes no file beside it', () => {
  const scripts = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts['test:core'], 'node scripts/run-web-tests.mjs --core');
  assert.equal(scripts['test:browser:smoke'], 'node scripts/run-browser-smoke.mjs');
  // Not a part of this run (`node --test` marks its files' processes).
  const { NODE_TEST_CONTEXT: _part, ...env } = process.env;
  const refused = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-web-tests.mjs'), '--core', 'tests/debounce-contract.test.mjs'], { encoding: 'utf8', env });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /--core runs the core contract tests and takes no file/);
});
