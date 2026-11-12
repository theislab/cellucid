/**
 * The action reference page of the docs (`scripts/generate-action-reference.mjs`)
 * lists every action of the catalog, and the page in the docs tree is what
 * the generator writes from this checkout's catalog: an action added,
 * renamed or given another parameter fails here until the page is
 * regenerated. The page lives in the shared docs site (CELLUCID_PYTHON_DOCS,
 * else the sibling `cellucid-python/docs`); while it has not landed there the
 * comparison is skipped and says how to write it.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ACTION_REFERENCE_PAGE, actionReferencePath, renderActionReference,
} from '../scripts/generate-action-reference.mjs';
import { defineAction } from '../assets/js/app/actions/catalog.js';
import { ACTION_DEFINITIONS } from '../assets/js/app/actions/definitions/index.js';
import { getActionCatalog } from '../assets/js/app/actions/index.js';
import { DOMAIN_IDS } from '../assets/js/app/actions/domains.js';

test('the reference lists every action of the catalogue once, each under its group, and every domain', () => {
  const text = renderActionReference();
  const headings = [...text.matchAll(/^### `([^`]+)`$/gm)].map(match => match[1]);
  const types = getActionCatalog().list().map(definition => definition.type);
  assert.deepEqual([...headings].sort(), [...types].sort(), 'one section per action type, no other');
  for (const type of types) {
    const definition = getActionCatalog().get(type);
    const section = text.slice(text.indexOf(`### \`${type}\``)).split(/\n### /)[0];
    const group = text.slice(0, text.indexOf(`### \`${type}\``)).match(/^## (.+)$/gm).at(-1);
    assert.equal(group, `## ${definition.group}`, `${type} is listed under its group`);
    for (const name of Object.keys(definition.params.properties ?? {})) {
      assert.ok(section.includes(`| \`${name}\` |`), `${type}: its parameter ${name} is in its table`);
    }
    if (definition.effect === 'read') {
      for (const name of Object.keys(definition.result.properties ?? {})) {
        assert.ok(section.includes(`| \`${name}\` |`), `${type}: the field ${name} it returns is in its table`);
      }
    } else {
      assert.match(section, /^Timeline label: \S.*$/m, `${type} shows its label`);
      assert.match(section, /^Pseudocode: `.+`$/m, `${type} shows its pseudocode`);
    }
  }
  for (const id of DOMAIN_IDS) assert.ok(text.includes(`| \`${id}\` |`), `the domain ${id} is listed`);
  assert.equal(renderActionReference(), text, 'the same catalogue gives the same page');
});

test('an action added to the catalogue is a new section of the reference', () => {
  const added = defineAction({
    type: 'example.added',
    title: 'An added action',
    summary: 'What a new area would add.',
    group: 'Example',
    params: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', minLength: 1, examples: ['a'] } } },
    touches: ['settings'],
    reads: [], effect: 'view',
    describe: p => `Did ${p.name ?? 'it'}`,
    code: p => `do(${JSON.stringify(p.name ?? null)})`,
  });
  const text = renderActionReference([...ACTION_DEFINITIONS, added]);
  assert.match(text, /^## Example\n\n### `example\.added`$/m);
  assert.notEqual(text, renderActionReference(), 'the page changes with the catalogue');
});

test('the docs page is what the generator writes from this catalogue', t => {
  const target = actionReferencePath();
  if (!existsSync(target)) {
    t.skip(`${ACTION_REFERENCE_PAGE} is not in the docs tree yet (${target}); write it with node scripts/generate-action-reference.mjs and add it to the developer docs toctree`);
    return;
  }
  assert.equal(
    readFileSync(target, 'utf8'),
    renderActionReference(),
    `${target} is stale: run node scripts/generate-action-reference.mjs (an action was added, renamed or changed)`,
  );
});
