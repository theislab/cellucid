/**
 * Min annotators is bounded only by what the contract carries (a JSON safe
 * integer): an author's 100 stays 100 (the panel does not clamp a value
 * to 50 and republish it), and input the field cannot mean keeps the value
 * in force instead of rewriting it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { minAnnotatorsFromInput } from '../assets/js/app/ui/modules/community-annotation/consensus-math.js';

test('any non-negative safe integer is kept exactly', () => {
  assert.equal(minAnnotatorsFromInput('0', 7), 0);
  assert.equal(minAnnotatorsFromInput('100', 7), 100);
  assert.equal(minAnnotatorsFromInput(' 51 ', 7), 51);
  assert.equal(minAnnotatorsFromInput(String(Number.MAX_SAFE_INTEGER), 7), Number.MAX_SAFE_INTEGER);
});

test('input that is not a count keeps the value in force', () => {
  for (const raw of ['', '-1', '2.5', '1e3', 'abc', String(Number.MAX_SAFE_INTEGER + 1), '99999999999999999999']) {
    assert.equal(minAnnotatorsFromInput(raw, 100), 100, raw);
  }
});

test('the panel neither caps the inputs nor clamps their values', () => {
  const source = readFileSync(
    new URL('../assets/js/app/ui/modules/community-annotation/controls-panel.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /\bmax:\s*'\d+'/);
  assert.doesNotMatch(source, /clampInt\(/);
  assert.equal((source.match(/minAnnotatorsFromInput\(/g) || []).length, 2);
});
