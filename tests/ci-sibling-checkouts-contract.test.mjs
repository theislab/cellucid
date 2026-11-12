/**
 * The Node job of `.github/workflows/test.yml` checks out only the files of
 * each sibling repository its contracts read (sparse: the rest of cellucid-python
 * alone is hundreds of megabytes). A shared file added to a generator and not to
 * these lists passes on every machine with a whole checkout and fails on every CI
 * job with ENOENT (`history_model.schema.json`, CI run 42129386525), so each
 * list is held here to what the generators write, and what is read beside them.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { ACTION_CATALOG_MIRRORS, MCP_TOOLS_MIRRORS } from '../scripts/generate-action-catalog.mjs';
import { HISTORY_GOLDEN_MIRRORS, PACKAGE_SESSION_NAME } from '../scripts/generate-history-golden.mjs';
import { HISTORY_MODEL_MIRRORS } from '../scripts/generate-history-model.mjs';

const WORKFLOW = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');

/** The sparse-checkout patterns of the step that checks out `repository`, in order. */
function sparseList(repository) {
  const step = WORKFLOW.match(new RegExp(`repository: theislab/${repository}\\n(?:.*\\n)*?\\s+sparse-checkout: \\|\\n((?:\\s{12}.*\\n)+)`));
  assert.ok(step, `the Node job checks out ${repository}`);
  return step[1].trim().split('\n').map(line => line.trim());
}

/**
 * What the generators write of `repository`: its copies, the golden history's
 * folder, and the session a package ships as its help pages' example (`example`:
 * cellucid-r's `inst/extdata`, read by `history-golden-fixture.test.mjs`; left
 * out of the list once, CI run 42812443830).
 */
function generated(repository) {
  const files = [ACTION_CATALOG_MIRRORS, MCP_TOOLS_MIRRORS, HISTORY_MODEL_MIRRORS]
    .flatMap(mirrors => mirrors.filter(mirror => mirror.repository === repository).map(mirror => mirror.file));
  const mirrors = HISTORY_GOLDEN_MIRRORS.filter(mirror => mirror.repository === repository);
  const golden = mirrors.map(mirror => `${mirror.dir}/`);
  const examples = mirrors.filter(mirror => mirror.example !== null).map(mirror => `${mirror.example}/${PACKAGE_SESSION_NAME}`);
  return [...files, ...golden, ...examples];
}

test('the Node job checks out every file the contracts read of cellucid-python', () => {
  assert.deepEqual(sparseList('cellucid-python').sort(), [
    ...generated('cellucid-python'),
    // `tests/notebook-widget-requests-contract.test.mjs`.
    'src/cellucid/jupyter/static/widget.js',
    // The pages the citation, info tips, analysis options and action reference contracts read.
    'docs/**/*.md',
  ].sort());
});

test('the Node job checks out every file the contracts read of cellucid-r', () => {
  assert.deepEqual(sparseList('cellucid-r').sort(), [
    ...generated('cellucid-r'),
    'inst/widget/widget.js',
  ].sort());
});

test('the Node job checks out the published session presets of cellucid-datasets, and their reader', () => {
  assert.deepEqual(sparseList('cellucid-datasets'), [
    'anndata/datasets.json',
    'anndata/*.cellucid-session',
    // `state-record-added-keys.test.mjs` reads the starting views as they are
    // published (`readStartingView()`); the module imports its store reader.
    // Left out once, CI run 43106620008.
    'scripts/publish_session_preset.mjs',
    'scripts/anndata_store.mjs',
  ]);
});
