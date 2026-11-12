/**
 * A parameter refused for its form says the form in words (R9R-5): "the
 * expected form" left a person and an agent to guess what a keyframe label,
 * a view name or a color must look like. Every `pattern` of the catalog's
 * parameters is said by `PATTERN_WORDS` or by a string example of its schema.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { getActionCatalog } from '../assets/js/app/actions/index.js';
import { patternWords } from '../assets/js/app/actions/schema.js';

function* patternsOf(schema, path) {
  if (schema === null || typeof schema !== 'object') return;
  if (typeof schema.pattern === 'string') yield { schema, path };
  for (const [key, child] of Object.entries(schema.properties ?? {})) yield* patternsOf(child, `${path}.${key}`);
  if (schema.items !== undefined) yield* patternsOf(schema.items, `${path}[]`);
  for (const [index, child] of (schema.oneOf ?? []).entries()) yield* patternsOf(child, `${path}.oneOf[${index}]`);
}

test('every pattern of an action parameter is said in words or by an example', () => {
  const unsaid = [];
  let count = 0;
  for (const definition of getActionCatalog().list()) {
    for (const { schema, path } of patternsOf(definition.params, definition.type)) {
      count += 1;
      if (patternWords(schema) === null) unsaid.push(`${path}: ${schema.pattern}`);
    }
  }
  assert.ok(count > 0, 'the catalog has patterns to check');
  assert.deepEqual(unsaid, []);
});

test('a refusal of a keyframe label, a view and a color says the form', () => {
  const catalog = getActionCatalog();
  assert.throws(
    () => catalog.check('camera-path.keyframe.rename', { keyframe: 'KF 1', label: ' trailing ' }),
    /label " trailing " must be a name with no space at its start or end/,
  );
  assert.throws(() => catalog.check('view.focus', { view: 'live' }), /view "live" must be a view name such as "View 2"/);
  assert.throws(() => catalog.check('history.step', { step: 'step 3' }), /must be like "s3"/);
});
