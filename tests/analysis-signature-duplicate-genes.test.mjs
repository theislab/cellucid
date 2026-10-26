/**
 * A gene listed twice is scored once, never a failure: the editor keeps one
 * of each, matching resolves each dataset gene once, and the engine refuses
 * a set that still names a gene twice (a programming error, not a user's).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseGeneText, resolveGenes } from '../assets/js/app/analysis/shared/gene-sets.js';
import { MultiVariableAnalysis } from '../assets/js/app/analysis/stats/multi-variable-analysis.js';

test('a gene typed twice, or twice by case, is matched once', () => {
  assert.deepEqual(parseGeneText('CD3E, CD8A, CD3E'), ['CD3E', 'CD8A']);
  assert.deepEqual(resolveGenes(['CD3E', 'cd3e', 'CD8A'], ['CD3E', 'CD8A']).resolved, ['CD3E', 'CD8A']);
});

test('the engine refuses a set that names a gene twice before reading anything', async () => {
  const analysis = Object.create(MultiVariableAnalysis.prototype);
  analysis.dataLayer = new Proxy({}, {
    get() {
      throw new Error('a refused request reached the data');
    },
  });
  await assert.rejects(
    analysis.computeSignatureScore({ geneSets: [{ name: 'S', genes: ['CD3E', 'CD3E'] }], pageIds: ['p'] }),
    /distinct gene keys/,
  );
});
