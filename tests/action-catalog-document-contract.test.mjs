/**
 * The action catalog document that Python and R are generated from.
 *
 * `tests/fixtures/action-catalog.json` is `catalogDocument` of every action
 * definition as canonical JSON (`scripts/generate-action-catalog.mjs`), and
 * cellucid-python (`src/cellucid/action_catalog.json`) and cellucid-r
 * (`inst/action_catalog.json`) hold it byte for byte, each pinning the same
 * SHA-256. An action added, renamed or given another parameter without
 * regenerating fails here, naming the command; the copies are compared too
 * when the sibling checkouts are present.
 *
 * Every action must also be expressible in both packages: its tool name is a
 * Python method and an R function name, and its top-level parameters are
 * keyword arguments in both languages.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ACTION_CATALOG_PATH,
  actionCatalogMirrorPaths,
  renderActionCatalog,
} from '../scripts/generate-action-catalog.mjs';
import { catalogDocument, createActionCatalog, toolNameOf } from '../assets/js/app/actions/catalog.js';
import { ACTION_DEFINITIONS } from '../assets/js/app/actions/definitions/index.js';

/**
 * The digest of `action-catalog.json`. cellucid-python
 * (`tests/test_action_catalog.py`) and cellucid-r
 * (`tests/testthat/test-actions.R`) pin the same one.
 */
const ACTION_CATALOG_SHA256 = '725d32e5357cebbcff332be5a599667cf42ebb63ce55bd73e39ce4a1469556c4';

const REGENERATE = 'Run node scripts/generate-action-catalog.mjs (it writes the three copies and prints the digest), '
  + 'then python scripts/generate_actions.py in cellucid-python and Rscript tools/generate-actions.R in cellucid-r, '
  + 'and pin the printed digest in the three tests.';

test('action-catalog.json is the catalogue the definitions make now, at the pinned digest', () => {
  const current = readFileSync(ACTION_CATALOG_PATH, 'utf8');
  assert.ok(current === renderActionCatalog(), `tests/fixtures/action-catalog.json is stale. ${REGENERATE}`);
  assert.equal(createHash('sha256').update(current).digest('hex'), ACTION_CATALOG_SHA256, REGENERATE);
});

test('the copies Python and R build from are the same bytes', t => {
  const expected = readFileSync(ACTION_CATALOG_PATH, 'utf8');
  for (const mirror of actionCatalogMirrorPaths()) {
    if (mirror.path === null) {
      t.diagnostic(`${mirror.repository} is not beside this checkout (set ${mirror.env}); its copy is checked there`);
      continue;
    }
    assert.ok(readFileSync(mirror.path, 'utf8') === expected, `${mirror.repository}/${mirror.file} differs. ${REGENERATE}`);
  }
});

test('the document is canonical: sorted keys, two-space indent, one trailing newline', () => {
  const text = readFileSync(ACTION_CATALOG_PATH, 'utf8');
  const sorted = value => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
    }
    return value;
  };
  const parsed = JSON.parse(text);
  assert.equal(text, `${JSON.stringify(sorted(parsed), null, 2)}\n`);
  assert.deepEqual(parsed, sorted(catalogDocument(createActionCatalog(ACTION_DEFINITIONS))));
});

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

test('every action is a Python method and an R function, and every parameter a keyword of both', () => {
  const document = JSON.parse(readFileSync(ACTION_CATALOG_PATH, 'utf8'));
  assert.equal(document.schema, 1);
  const tools = new Set();
  for (const action of document.actions) {
    assert.equal(action.tool, toolNameOf(action.type), `${action.type}: tool name`);
    assert.match(action.tool, IDENTIFIER, `${action.type}: the tool name is an identifier in Python and R`);
    assert.ok(!tools.has(action.tool), `${action.tool} names one action`);
    tools.add(action.tool);
    assert.equal(action.params.type, 'object', `${action.type}: params are keyword arguments`);
    for (const name of Object.keys(action.params.properties ?? {})) {
      // `in` is a keyword in both languages; the generators append an
      // underscore to it (`in_`) and send it as `in`.
      assert.match(name, IDENTIFIER, `${action.type}: parameter "${name}" is an identifier in Python and R`);
      assert.ok(!name.endsWith('_'), `${action.type}: parameter "${name}" must not end in "_" (reserved for keywords)`);
    }
  }
});
