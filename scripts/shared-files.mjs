/**
 * The files other Cellucid repositories hold a byte-for-byte copy of, said
 * once.
 *
 * What the web app, the Python package and the R package must agree on (the
 * action catalog, the agents' tools, the history model, the input-format
 * registry, the viewer protocol, the conformance fixtures, the golden
 * history, the older AnnData layouts) is one file with its home in this
 * repository and a copy in each package that reads it. Nothing pins a digest
 * of one. Three things keep them the same:
 *
 * - `tests/shared-files-contract.test.mjs` compares every copy with its home;
 * - each package's own tests compare their copy with this repository's file;
 * - `node scripts/sync-shared-files.mjs` makes every home that has a
 *   generator and writes every copy (`--check` names what is stale).
 *
 * A sibling repository is found where its variable says, else beside this
 * checkout. One that is not there is named and skipped, unless
 * `CELLUCID_REQUIRE_SIBLINGS=1` (each repository's CI) makes that a failure.
 *
 * A new shared file is one entry here; the generators that write copies
 * (`generate-action-catalog.mjs`, `generate-history-model.mjs`,
 * `generate-history-golden.mjs`, `generate-category-default-colors.mjs`;
 * `generate-protocol-documents.mjs` writes its two homes only)
 * take their copies' places from this list, and so does the list of files
 * CI checks out of each sibling (`tests/ci-sibling-checkouts-contract.test.mjs`).
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Each sibling repository a shared file lives in or is copied to, or a contract reads, and the variable that says where it is. */
export const SIBLING_REPOSITORIES = Object.freeze({
  'cellucid-python': 'CELLUCID_PYTHON_ROOT',
  'cellucid-r': 'CELLUCID_R_ROOT',
  'cellucid-annotation': 'CELLUCID_ANNOTATION_ROOT',
  'cellucid-datasets': 'CELLUCID_DATASETS_ROOT',
});

const PYTHON_FIXTURES = 'tests/fixtures';
const R_FIXTURES = 'tests/testthat/fixtures';

/** One shared file: its home here, the script that makes the home (null for a fixture kept as it is), each copy's place. */
function shared(home, generator, copies) {
  return Object.freeze({
    home,
    generator,
    copies: Object.freeze(Object.entries(copies).flatMap(([repository, files]) => (
      [files].flat().map(file => Object.freeze({ repository, env: SIBLING_REPOSITORIES[repository], file }))
    ))),
  });
}

/** A fixture both packages keep under their test fixtures, hyphens as underscores. */
function fixture(name, generator = null) {
  const copy = name.replaceAll('-', '_');
  return shared(`tests/fixtures/${name}`, generator, {
    'cellucid-python': `${PYTHON_FIXTURES}/${copy}`,
    'cellucid-r': `${R_FIXTURES}/${copy}`,
  });
}

/** A file both packages ship (the same name with underscores, in their package data). */
function shipped(name, generator) {
  const copy = name.replaceAll('-', '_');
  return shared(`tests/fixtures/${name}`, generator, {
    'cellucid-python': `src/cellucid/${copy}`,
    'cellucid-r': `inst/${copy}`,
  });
}

const GOLDEN = 'scripts/generate-history-golden.mjs';
const OLDER_ANNDATA = Object.freeze([
  'legacy-0.6-compound-obsm.h5ad', 'legacy-0.6-twin-current.h5ad', 'legacy-0.6.h5ad', 'legacy-0.7-csr.h5ad',
  'legacy-0.7-dense.h5ad', 'legacy-0.7.zarr.zip', 'legacy-h5sparse.h5ad', 'legacy-seuratdisk.h5ad',
  'legacy-twin-current.h5ad',
]);

export const SHARED_FILES = Object.freeze([
  shipped('action-catalog.json', 'scripts/generate-action-catalog.mjs'),
  shipped('mcp-tools.json', 'scripts/generate-action-catalog.mjs'),
  shipped('history-model.schema.json', 'scripts/generate-history-model.mjs'),
  shipped('input-formats.json', 'scripts/generate-protocol-documents.mjs'),
  fixture('viewer-protocol.json', 'scripts/generate-protocol-documents.mjs'),
  fixture('category-default-colors.json', 'scripts/generate-category-default-colors.mjs'),
  fixture('data-mapping-conformance.json'),
  fixture('subsample-conformance.json'),
  fixture('latent-outlier-conformance.json'),
  fixture('gene-sets.gmt'),
  fixture('obs-columns.csv'),
  // The golden history: both packages read the three files; cellucid-r also ships the session as its help pages' example.
  shared('tests/fixtures/history-golden.cellucid-session', GOLDEN, {
    'cellucid-python': `${PYTHON_FIXTURES}/history_golden/history_golden.cellucid-session`,
    'cellucid-r': [`${R_FIXTURES}/history_golden/history_golden.cellucid-session`, 'inst/extdata/history_golden.cellucid-session'],
  }),
  shared('tests/fixtures/history-golden.expected.json', GOLDEN, {
    'cellucid-python': `${PYTHON_FIXTURES}/history_golden/history_golden.expected.json`,
    'cellucid-r': `${R_FIXTURES}/history_golden/history_golden.expected.json`,
  }),
  shared('tests/fixtures/history-golden-state.cellucid-session', GOLDEN, {
    'cellucid-python': `${PYTHON_FIXTURES}/history_golden/history_golden_state.cellucid-session`,
    'cellucid-r': `${R_FIXTURES}/history_golden/history_golden_state.cellucid-session`,
  }),
  // Files in the layouts anndata wrote before 0.8 (`scripts/generate-legacy-anndata-fixtures.py`, run with those versions).
  ...OLDER_ANNDATA.map(name => shared(`tests/browser/fixtures/${name}`, null, {
    'cellucid-python': `${PYTHON_FIXTURES}/older_anndata/${name}`,
  })),
]);

/**
 * Files held here whose home is another repository: `file` here is a
 * byte-for-byte copy of `home` there, written by `make` (run there).
 */
export const HELD_COPIES = Object.freeze([
  Object.freeze({
    file: 'tests/fixtures/community-annotation-contract-corpus.json',
    repository: 'cellucid-annotation',
    env: SIBLING_REPOSITORIES['cellucid-annotation'],
    home: 'tests/fixtures/contract-corpus.json',
    make: 'python scripts/generate_contract_corpus.py --copy ../cellucid/tests/fixtures/community-annotation-contract-corpus.json',
  }),
]);

/** The shared file whose home is `home` (a path of this repository). */
export function sharedFile(home) {
  const entry = SHARED_FILES.find(file => file.home === home);
  if (entry === undefined) throw new RangeError(`${home} is not a shared file (scripts/shared-files.mjs)`);
  return entry;
}

/** Where `repository` is: at the path its variable names, else beside this checkout; null when it is not there. */
export function siblingRoot(repository, env = process.env) {
  const variable = SIBLING_REPOSITORIES[repository];
  if (variable === undefined) throw new RangeError(`${repository} is no sibling repository of this one (SIBLING_REPOSITORIES)`);
  const root = env[variable] ?? path.join(ROOT, '..', repository);
  return existsSync(root) ? root : null;
}

/** Whether a sibling repository that is not there is a failure (`CELLUCID_REQUIRE_SIBLINGS=1`). */
export function siblingsRequired(env = process.env) {
  return env.CELLUCID_REQUIRE_SIBLINGS === '1';
}

/** The documentation site: `CELLUCID_PYTHON_DOCS`, else `docs` of the cellucid-python checkout (its variable, else beside this one). */
export function pythonDocsRoot(env = process.env) {
  return env.CELLUCID_PYTHON_DOCS ?? path.join(env.CELLUCID_PYTHON_ROOT ?? path.join(ROOT, '..', 'cellucid-python'), 'docs');
}

/**
 * Whether what a contract reads of a sibling repository is absent and the
 * contract may go without it. Where siblings are required it is a failure:
 * a contract that skips in the job that is the gate holds nothing.
 */
export function absentSibling(present, what) {
  if (present) return false;
  assert.ok(!siblingsRequired(), `${what}, and CELLUCID_REQUIRE_SIBLINGS=1 asks for it`);
  return true;
}

/** Skips the running test, saying `what` is missing, when `absentSibling()` allows it; true when it did. */
export function skipAbsentSibling(t, present, what) {
  if (!absentSibling(present, what)) return false;
  t.skip(what);
  return true;
}

/** Each copy of one shared file: `{repository, env, file, path}`, `path` null when its repository is not there. */
export function copyPaths(entry, env = process.env) {
  return entry.copies.map(copy => {
    const root = siblingRoot(copy.repository, env);
    return { ...copy, path: root === null ? null : path.join(root, copy.file) };
  });
}

/**
 * What this repository's contracts read of `repository`'s shared files, as
 * paths of that repository, each once: its copies, and the homes of the
 * files held here.
 */
export function sharedPathsIn(repository) {
  return [...new Set([
    ...SHARED_FILES.flatMap(entry => entry.copies.filter(copy => copy.repository === repository).map(copy => copy.file)),
    ...HELD_COPIES.filter(held => held.repository === repository).map(held => held.home),
  ])];
}
