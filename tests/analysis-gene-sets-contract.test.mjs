/**
 * Gene lists as users type, paste and import them, matched to a dataset's
 * genes without ever throwing (`analysis/shared/gene-sets.js`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseGeneFile,
  parseGeneTable,
  parseGeneText,
  parseGmt,
  resolveGenes
} from '../assets/js/app/analysis/shared/gene-sets.js';

test('typed and pasted text splits on commas, semicolons, spaces, tabs and new lines', () => {
  assert.deepEqual(
    parseGeneText('CD3E, CD4;CD8A\tMS4A1\nCD14\r\n  "LYZ"  CD3E,,'),
    ['CD3E', 'CD4', 'CD8A', 'MS4A1', 'CD14', 'LYZ']
  );
  assert.deepEqual(parseGeneText(''), []);
  assert.deepEqual(parseGeneText(' ,; \n'), []);
});

test('GMT: one set per line, name, description, genes', () => {
  const sets = parseGmt('T_CELLS\thttp://x\tCD3E\tCD3D\n\nB_CELLS\t\tMS4A1\tCD79A\tMS4A1\nT_CELLS\tdup\tCD2\n');
  assert.deepEqual(sets, [
    { name: 'T_CELLS', description: 'http://x', genes: ['CD3E', 'CD3D'] },
    { name: 'B_CELLS', description: '', genes: ['MS4A1', 'CD79A'] },
    { name: 'T_CELLS (2)', description: 'dup', genes: ['CD2'] },
  ]);
});

test('tables: one column, long set/gene columns, and wide columns', () => {
  assert.deepEqual(parseGeneTable('gene\nCD3E\nCD4\n', { name: 'mine' }), [{ name: 'mine', genes: ['CD3E', 'CD4'] }]);
  assert.deepEqual(
    parseGeneTable('cluster,names,scores\n0,CD3E,5\n1,MS4A1,4\n0,CD4,3\n'),
    [{ name: '0', genes: ['CD3E', 'CD4'] }, { name: '1', genes: ['MS4A1'] }]
  );
  assert.deepEqual(
    parseGeneTable('T cells\tB cells\nCD3E\tMS4A1\nCD4\t\n'),
    [{ name: 'T cells', genes: ['CD3E', 'CD4'] }, { name: 'B cells', genes: ['MS4A1'] }]
  );
  assert.deepEqual(parseGeneTable('"set","gene"\n"a, b","X"\n'), [{ name: 'a, b', genes: ['X'] }]);
});

test('a file is read by its extension', () => {
  assert.deepEqual(parseGeneFile('t.txt', 'A B'), [{ name: 't', genes: ['A', 'B'] }]);
  assert.deepEqual(parseGeneFile('s.gmt', 'S\t\tA\n'), [{ name: 'S', genes: ['A'] }]);
  assert.deepEqual(parseGeneFile('w.tsv', 'X\nA\n'), [{ name: 'w', genes: ['X', 'A'] }]);
});

test('names resolve exactly, then by case when one gene matches; the rest are reported', () => {
  const available = ['CD3E', 'Cd3e_alt', 'MS4A1', 'Actb', 'ACTB'];
  const result = resolveGenes(['CD3E', 'ms4a1', 'actb', 'NOPE', 'CD3E', '', 7], available);
  assert.deepEqual(result.resolved, ['CD3E', 'MS4A1']);
  assert.deepEqual(result.renamed, [{ requested: 'ms4a1', gene: 'MS4A1' }]);
  assert.deepEqual(result.ambiguous, [{ requested: 'actb', candidates: ['Actb', 'ACTB'] }]);
  assert.deepEqual(result.unmatched, ['NOPE']);
  assert.deepEqual(resolveGenes(null, available), { resolved: [], unmatched: [], ambiguous: [], renamed: [] });
});
