/**
 * The Node job of `.github/workflows/test.yml` checks out only the files of
 * each sibling repository its contracts read (sparse: the rest of cellucid-python
 * alone is hundreds of megabytes). A shared file added to the list of shared
 * files (`scripts/shared-files.mjs`) and not to these lists passes on every
 * machine with a whole checkout and fails on every CI job with ENOENT
 * (as `history_model.schema.json` would), so each list is held here
 * to the shared files, and what is read beside them. A contract that reads a
 * sibling and finds it missing fails where siblings are required
 * (`absentSibling()`), so a path left out here is a red job, not a skip.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { ACTION_REFERENCE_PAGE } from '../scripts/generate-action-reference.mjs';
import { SHORTCUT_REFERENCE_PAGE } from '../scripts/generate-shortcut-reference.mjs';
import { sharedPathsIn } from '../scripts/shared-files.mjs';
import { checkoutOf, readWorkflow } from './helpers/workflow.mjs';

const WORKFLOW = readWorkflow('test.yml');
const LLMS = readFileSync(new URL('../llms.txt', import.meta.url), 'utf8');

/** The sparse-checkout patterns of the step of job `id` that checks out `repository`, in order. */
function sparseList(repository, id = 'node') {
  const checkout = checkoutOf(WORKFLOW.jobs[id], repository);
  assert.ok(checkout, `the ${id} job checks out ${repository}`);
  assert.ok(typeof checkout['sparse-checkout'] === 'string', `the ${id} job checks out only part of ${repository}`);
  return checkout['sparse-checkout'].split('\n').map(line => line.trim()).filter(Boolean);
}

test('the Node job checks out every file the contracts read of cellucid-python', () => {
  assert.deepEqual(sparseList('cellucid-python').sort(), [
    ...sharedPathsIn('cellucid-python'),
    // `tests/notebook-widget-requests-contract.test.mjs`.
    'src/cellucid/jupyter/static/widget.js',
    // The pages the citation, info tips, analysis options and action reference contracts read.
    'docs/**/*.md',
    // `seo-head-contract.test.mjs`: the docs build's configuration, which names the llms.txt writer.
    'docs/conf.py',
  ].sort());
});

/** Whether a no-cone sparse-checkout `pattern` (`*` within a name, `**` across folders) holds `file`. */
function holds(pattern, file) {
  const source = pattern.split('**/').map(part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*')).join('(?:.*/)?');
  return new RegExp(`^${source}$`).test(file);
}

test('the Node job checks out every documentation file the contracts name', () => {
  const patterns = sparseList('cellucid-python');
  // The page behind each docs.cellucid.com link of llms.txt (`seo-head-contract.test.mjs`), as its source file.
  const linked = [...LLMS.matchAll(/\(https:\/\/docs\.cellucid\.com\/en\/latest\/([^)]*?)(?:\.html)?\)/g)]
    .map(match => match[1])
    .filter(page => !page.endsWith('.txt'))
    .map(page => `docs/${page === '' ? 'index' : page}.md`);
  assert.ok(linked.length >= 10, 'llms.txt links the docs pages');
  const named = [
    ...linked,
    'docs/conf.py',
    'docs/citing.md',
    `docs/${ACTION_REFERENCE_PAGE}`,
    `docs/${SHORTCUT_REFERENCE_PAGE}`,
  ];
  const left = named.filter(file => !patterns.some(pattern => holds(pattern, file)));
  assert.deepEqual(left, [], 'files a contract reads that the sparse checkout of cellucid-python leaves out');
});

test('the Node job checks out every file the contracts read of cellucid-r', () => {
  assert.deepEqual(sparseList('cellucid-r').sort(), [
    ...sharedPathsIn('cellucid-r'),
    'inst/widget/widget.js',
  ].sort());
});

test('the Node job checks out the published session presets of cellucid-datasets, and their reader', () => {
  assert.deepEqual(sparseList('cellucid-datasets'), [
    'anndata/datasets.json',
    'anndata/*.cellucid-session',
    // `state-record-added-keys.test.mjs` reads the starting views as they are
    // published (`readStartingView()`); the module imports its store reader.
    'scripts/publish_session_preset.mjs',
    'scripts/anndata_store.mjs',
  ]);
});

test('the viewers job checks out cellucid-python for its package and the golden history, and all of cellucid-r', () => {
  assert.deepEqual(sparseList('cellucid-python', 'viewers').sort(), [
    '/pyproject.toml', '/README.md', '/LICENSE', '/MANIFEST.in',
    // `pip install -e` builds the package from these, and the specs run its sources.
    '/src/',
    // `viewer-channel.spec.mjs` serves the golden history from the Python checkout.
    '/tests/fixtures/history_golden/history_golden.cellucid-session',
  ].sort());
  assert.ok(sharedPathsIn('cellucid-python').includes('tests/fixtures/history_golden/history_golden.cellucid-session'));
  // The R package is installed from its whole checkout: `src/` is compiled.
  const rPackage = checkoutOf(WORKFLOW.jobs.viewers, 'cellucid-r');
  assert.ok(rPackage, 'the viewers job checks out cellucid-r');
  assert.equal(rPackage['sparse-checkout'], undefined);
});

test('the Node job checks out the contract corpus of cellucid-annotation, and asks for every sibling', () => {
  assert.deepEqual(sparseList('cellucid-annotation').sort(), sharedPathsIn('cellucid-annotation').sort());
  assert.equal(WORKFLOW.jobs.node.env.CELLUCID_REQUIRE_SIBLINGS, '1');
});
