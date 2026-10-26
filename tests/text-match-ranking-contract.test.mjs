/**
 * A search box whose Enter takes the first match lists the match the reader
 * most likely meant first (`app/utils/text-match.js`): the name itself, then
 * names starting with the query, then names containing it, each in list
 * order. The gene search took the first substring match in file order, so
 * `TNF` + Enter coloured by whichever of `C1QTNF1`, `TNFAIP3` or `TNF` came
 * first in the file.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { rankedMatchIndices } from '../assets/js/app/utils/text-match.js';
import { createGeneIndex } from '../assets/js/app/analysis/shared/gene-sets.js';

test('the name itself first, then prefixes, then substrings, each in list order', () => {
  const keys = ['c1qtnf1', 'tnfaip3', 'litaf', 'tnf', 'tnfrsf1a', 'atnf'];
  assert.deepEqual(rankedMatchIndices(keys, 'tnf').map(index => keys[index]), [
    'tnf', 'tnfaip3', 'tnfrsf1a', 'c1qtnf1', 'atnf',
  ]);
  assert.deepEqual(rankedMatchIndices(keys, 'zz'), []);
});

test('the gene index keeps the names in file order with their lower case', () => {
  const index = createGeneIndex(['CD3E', 'Cd3e', 'MS4A1']);
  assert.deepEqual(index.names, ['CD3E', 'Cd3e', 'MS4A1']);
  assert.deepEqual(index.lowered, ['cd3e', 'cd3e', 'ms4a1']);
});

test('both gene search boxes rank their matches with it', () => {
  for (const file of [
    '../assets/js/app/ui/modules/field-selector-gene-expression.js',
    '../assets/js/app/analysis/ui/components/gene-set-editor.js',
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /rankedMatchIndices\(/, file);
    assert.doesNotMatch(source, /\.includes\((normalizedQuery|query)\)/, file);
  }
});
