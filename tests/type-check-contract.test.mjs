/**
 * The type check (`scripts/check-types.mjs`, `npm run check`) passes on the
 * web app's JavaScript, and still fails when it should.
 *
 * A check that reads no file, or whose compiler is told to check nothing,
 * passes on anything. So the same function is run over a folder of planted
 * defects (`tests/fixtures/type-check/`), one of each kind the check fails
 * on, each line saying the code it must be reported with
 * (`// expect TS2305`): every marked line is reported with its code, and no
 * other line is.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { FULLY_CHECKED, checkTypes } from '../scripts/check-types.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = 'tests/fixtures/type-check';

/** Every `.js` file under a folder of the repository, as paths from its root, in POSIX form. */
function scriptsUnder(folder) {
  return readdirSync(path.join(ROOT, folder), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => path.relative(ROOT, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort();
}

test('the web app\'s JavaScript passes the type check', () => {
  // Not a part of this run (`node --test` marks its files' processes).
  const { NODE_TEST_CONTEXT: _part, ...env } = process.env;
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-types.mjs')], { encoding: 'utf8', env });
  assert.equal(run.status, 0, `npm run check failed:\n${run.stdout}${run.stderr}`);
  assert.match(run.stdout, new RegExp(`^Type check: clean\\. \\d+ files, ${FULLY_CHECKED.length} folders fully checked`, 'm'));
});

test('every planted defect is reported with its code, and nothing else is', () => {
  const files = scriptsUnder(FIXTURES);
  const expected = [];
  for (const file of files) {
    readFileSync(path.join(ROOT, file), 'utf8').split('\n').forEach((line, index) => {
      const marker = /\/\/ expect ((?:TS\d+ ?)+)/.exec(line);
      for (const code of marker?.[1].trim().split(' ') ?? []) expected.push(`${file}:${index + 1} ${code}`);
    });
  }
  assert.ok(expected.length >= 30, 'the fixtures hold the planted defects');

  const result = checkTypes({
    files: files.map(file => path.join(ROOT, file)),
    sourceFolder: FIXTURES,
    fullyChecked: ['full'],
  });
  const reported = result.failures.map(entry => `${entry.file}:${entry.line} TS${entry.code}`);
  assert.deepEqual(reported.sort(), expected.sort());
  // Typing style outside a fully checked folder is counted and does not fail.
  assert.deepEqual(result.others.map(entry => `${entry.file}:${entry.line} TS${entry.code}`), [`${FIXTURES}/style.js:2 TS2551`]);
  assert.equal(result.fileCount, files.length);
});

test('a fully checked folder that holds no file is refused', () => {
  const files = scriptsUnder(FIXTURES).map(file => path.join(ROOT, file));
  assert.throws(
    () => checkTypes({ files, sourceFolder: FIXTURES, fullyChecked: ['nowhere'] }),
    /FULLY_CHECKED names tests\/fixtures\/type-check\/nowhere, which holds no checked \.js file/,
  );
});

test('no directive comment switches the check off under assets/js', () => {
  const directive = /@ts-(?:ignore|expect-error|nocheck|check)\b/;
  const found = [];
  for (const file of scriptsUnder('assets/js')) {
    readFileSync(path.join(ROOT, file), 'utf8').split('\n').forEach((line, index) => {
      if (directive.test(line)) found.push(`${file}:${index + 1}`);
    });
  }
  assert.deepEqual(found, [], 'fix what the line reports, in the code or in its JSDoc');
});

test('npm run check is the script, and the compiler is pinned', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts.check, 'node scripts/check-types.mjs');
  assert.match(manifest.devDependencies.typescript, /^\d+\.\d+\.\d+$/);
});
