/**
 * The categories of a text or boolean column (`data/discovered-categories.js`):
 * coded where they are read, listed in code-point order, each in the color
 * its label names, and grown by label without moving any label shown.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { categoryNameSlots, codeDiscoveredColumn, compareCategoryLabels, paletteOfSlots } from '../assets/js/data/discovered-categories.js';
import { getCategoryColor } from '../assets/js/data/palettes.js';

test('labels are in code-point order, as Python and R sort them; false before true', () => {
  const labels = ['b', '\u{1F600}', 'a', 'Ａ', 'B'];
  // U+1F600 sorts after U+FF21 by code point (JavaScript's own order puts it before).
  assert.deepEqual(codeDiscoveredColumn(labels, null, 'x').categories, ['B', 'a', 'b', 'Ａ', '\u{1F600}']);
  assert.deepEqual([...labels].sort(compareCategoryLabels), ['B', 'a', 'b', 'Ａ', '\u{1F600}']);
  assert.deepEqual(codeDiscoveredColumn([true, null, false], null, 'x').categories, [false, true]);
});

test('codes are narrowed to the storage the page keeps; a missing value is its marker', () => {
  const { categories, codes, added } = codeDiscoveredColumn(['b', null, 'a', 'b'], null, 'x');
  assert.deepEqual(categories, ['a', 'b']);
  assert.ok(codes instanceof Uint8Array);
  assert.deepEqual(Array.from(codes), [1, 255, 0, 1]);
  assert.equal(added, true);
  const wide = codeDiscoveredColumn(Array.from({ length: 300 }, (_, i) => `l${i}`), null, 'x');
  assert.ok(wide.codes instanceof Uint16Array);
});

test('rows coded under known categories keep them; a new label grows them in label order', () => {
  const known = ['b', 'd'];
  const same = codeDiscoveredColumn(['d', 'b'], known, 'x');
  assert.equal(same.added, false);
  assert.deepEqual([same.categories, Array.from(same.codes)], [['b', 'd'], [1, 0]]);
  const grown = codeDiscoveredColumn(['c', 'a', 'd'], known, 'x');
  assert.equal(grown.added, true);
  assert.deepEqual([grown.categories, Array.from(grown.codes)], [['a', 'b', 'c', 'd'], [2, 0, 3]]);
  // Integer labels (a Loom clustering) sort as numbers; NaN is missing.
  const numbers = codeDiscoveredColumn(Float64Array.of(10, 2, NaN), null, 'x');
  assert.deepEqual([numbers.categories, Array.from(numbers.codes)], [[2, 10], [1, 0, 255]]);
  assert.throws(() => codeDiscoveredColumn([{}], null, 'Observation field \'n\''), /holds a object value/);
});

test('a label\'s color is its own: the same set gives the same colors, whatever order the cells hold it in', () => {
  const labels = Array.from({ length: 40 }, (_, i) => `cluster-${i}`).sort();
  const slots = categoryNameSlots(labels);
  assert.equal(new Set(slots).size, labels.length, 'no two labels share a color');
  assert.deepEqual(categoryNameSlots(labels), slots, 'deterministic');
  assert.deepEqual(paletteOfSlots(slots)[0], [...getCategoryColor(slots[0])].slice(0, 3));
});

test('growing keeps every shown label\'s color; a new one takes a free color', () => {
  const before = ['a', 'b', 'c'];
  const slots = categoryNameSlots(before);
  const grown = ['A', 'a', 'b', 'bb', 'c'];
  const previous = new Map(before.map((label, i) => [label, slots[i]]));
  const after = categoryNameSlots(grown, previous);
  for (const label of before) assert.equal(after[grown.indexOf(label)], previous.get(label), label);
  assert.equal(new Set(after).size, grown.length);
});

test('a Loom clustering held as integers opens as categories, as a text table\'s does; other integers stay numbers', async () => {
  const { dense, group, openStore, strings } = await import('./helpers/anndata-store.mjs');
  const { loomView } = await import('../assets/js/data/anndata/views/loom.js');
  const nCells = 6;
  const tree = group({
    matrix: dense(new Float32Array(2 * nCells), [2, nCells]),
    col_attrs: group({
      CellID: strings(Array.from({ length: nCells }, (_, i) => `c${i}`)),
      ClusterID: dense(Int32Array.of(10, 2, 2, 10, 0, 2), [nCells], { dtype: '<i4' }),
      nUMI: dense(Int32Array.of(5, 6, 7, 8, 9, 10), [nCells], { dtype: '<i4' }),
      _X: dense(Float32Array.of(0, 1, 2, 3, 4, 5), [nCells]),
      _Y: dense(Float32Array.of(5, 3, 1, 0, 2, 4), [nCells]),
    }),
    row_attrs: group({ Gene: strings(['g0', 'g1']) }),
  });
  const { root } = await openStore(tree);
  const obs = loomView(root, { name: 'x.loom' }).get('obs');
  assert.equal(obs.get('ClusterID').labels, true);
  assert.equal(obs.get('nUMI').labels, false);
  // Coded as labels: numeric order, not text order.
  const values = await obs.get('ClusterID').read();
  const { categories, codes } = codeDiscoveredColumn(Array.from(values), null, 'ClusterID');
  assert.deepEqual(categories, [0, 2, 10]);
  assert.deepEqual(Array.from(codes), [2, 1, 1, 2, 0, 1]);
});
