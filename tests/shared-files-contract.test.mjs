/**
 * Every copy of a shared file is its home, byte for byte
 * (`scripts/shared-files.mjs`).
 *
 * What the web app, the Python package and the R package must agree on is
 * one file with its home in one repository and a copy in each other one that
 * reads it. No test pins a digest of such a file: this one compares the
 * bytes, in both directions (the copies the packages hold of this
 * repository's files, and the copies held here of another repository's).
 * A sibling repository that is not beside this checkout is named and
 * skipped, unless `CELLUCID_REQUIRE_SIBLINGS=1` (CI) makes that a failure.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  HELD_COPIES, ROOT, SHARED_FILES, SIBLING_REPOSITORIES, absentSibling, copyPaths, pythonDocsRoot, siblingRoot, siblingsRequired,
} from '../scripts/shared-files.mjs';

const MAKE_AGREE = 'Run node scripts/sync-shared-files.mjs (it makes the homes and writes every copy), '
  + 'then the packages\' own generators (see that script\'s header).';

/** Skip, or fail where siblings are required, for a repository that is not there. */
function absent(t, repository) {
  const missing = `${repository} is not beside this checkout (set ${SIBLING_REPOSITORIES[repository]})`;
  if (!absentSibling(siblingRoot(repository) !== null, missing)) return false;
  t.diagnostic(`${missing}; its copies are compared there`);
  return true;
}

test('every shared file is listed once, has its home here and names each copy once', () => {
  const homes = SHARED_FILES.map(entry => entry.home);
  assert.equal(new Set(homes).size, homes.length, 'a home listed twice');
  for (const home of homes) assert.ok(existsSync(path.join(ROOT, home)), `${home} is not in this repository`);
  const copies = SHARED_FILES.flatMap(entry => entry.copies.map(copy => `${copy.repository}/${copy.file}`));
  assert.equal(new Set(copies).size, copies.length, 'one place is the copy of two files');
  for (const entry of SHARED_FILES) {
    assert.ok(entry.copies.length > 0, `${entry.home} has no copy`);
    assert.ok(entry.generator === null || existsSync(path.join(ROOT, entry.generator)), `${entry.home}: ${entry.generator} is not a script here`);
  }
});

for (const repository of new Set(SHARED_FILES.flatMap(entry => entry.copies.map(copy => copy.repository)))) {
  test(`${repository} holds every shared file byte for byte`, t => {
    if (absent(t, repository)) return;
    const stale = [];
    for (const entry of SHARED_FILES) {
      const home = readFileSync(path.join(ROOT, entry.home));
      for (const copy of copyPaths(entry).filter(candidate => candidate.repository === repository)) {
        if (!existsSync(copy.path) || !readFileSync(copy.path).equals(home)) stale.push(`${repository}/${copy.file} is not ${entry.home}`);
      }
    }
    assert.deepEqual(stale, [], `${stale.join('\n')}\n${MAKE_AGREE}`);
  });
}

for (const held of HELD_COPIES) {
  test(`${held.file} is ${held.repository}'s ${held.home}, byte for byte`, t => {
    assert.ok(existsSync(path.join(ROOT, held.file)), `${held.file} is not in this repository`);
    if (absent(t, held.repository)) return;
    const home = path.join(siblingRoot(held.repository), held.home);
    assert.ok(existsSync(home) && readFileSync(home).equals(readFileSync(path.join(ROOT, held.file))),
      `${held.file} differs from ${held.repository}/${held.home}. In ${held.repository}, run: ${held.make}`);
  });
}

test('a sibling that is not there is allowed to be absent, and fails where siblings are required', () => {
  const before = process.env.CELLUCID_REQUIRE_SIBLINGS;
  try {
    delete process.env.CELLUCID_REQUIRE_SIBLINGS;
    assert.equal(siblingsRequired(), false);
    assert.equal(absentSibling(true, 'there'), false);
    assert.equal(absentSibling(false, 'not there'), true);
    process.env.CELLUCID_REQUIRE_SIBLINGS = '1';
    assert.equal(siblingsRequired(), true);
    assert.equal(absentSibling(true, 'there'), false);
    assert.throws(() => absentSibling(false, 'the docs are not there'), /the docs are not there, and CELLUCID_REQUIRE_SIBLINGS=1 asks for it/);
  } finally {
    if (before === undefined) delete process.env.CELLUCID_REQUIRE_SIBLINGS;
    else process.env.CELLUCID_REQUIRE_SIBLINGS = before;
  }
});

test('the documentation site is where its variable says, else in the cellucid-python checkout', () => {
  assert.equal(pythonDocsRoot({ CELLUCID_PYTHON_DOCS: '/docs', CELLUCID_PYTHON_ROOT: '/python' }), '/docs');
  assert.equal(pythonDocsRoot({ CELLUCID_PYTHON_ROOT: '/python' }), path.join('/python', 'docs'));
  assert.equal(pythonDocsRoot({}), path.join(ROOT, '..', 'cellucid-python', 'docs'));
});
