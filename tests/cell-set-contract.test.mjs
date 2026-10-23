/**
 * Cell selections never live in a JS Set or Map: V8 refuses more than
 * 16,777,216 entries, so a selection of a large cluster at 30M+ cells failed
 * outright. They are CellSets (app/utils/cell-set.js), one bit a cell.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  CellSet,
  cellListFrom,
  cellListsEqual,
  requireCellList,
} from '../assets/js/app/utils/cell-set.js';
import { combineAnnotationCandidates } from '../assets/js/app/ui/modules/highlight/annotation-cells.js';

test('CellSet behaves as a Set of cell indices, iterating ascending', () => {
  const set = new CellSet(100);
  for (const cell of [64, 3, 99, 3, 0, 31, 32]) set.add(cell);
  assert.equal(set.size, 6);
  assert.deepEqual(set.toArray(), [0, 3, 31, 32, 64, 99]);
  assert.deepEqual(Array.from(set), [0, 3, 31, 32, 64, 99]);
  assert.deepEqual(Array.from(set.toUint32Array()), [0, 3, 31, 32, 64, 99]);
  assert.equal(set.has(31), true);
  assert.equal(set.has(30), false);
  assert.equal(set.has(-1), false);
  assert.equal(set.has(100), false);
  assert.equal(set.delete(31), true);
  assert.equal(set.delete(31), false);
  assert.equal(set.size, 5);
  assert.throws(() => set.add(100), RangeError);
  assert.throws(() => set.add(1.5), RangeError);
  assert.throws(() => new CellSet(undefined), RangeError);
});

test('CellSet algebra matches Set algebra and keeps the count exact', () => {
  let seed = 9;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const cellCount = 1000;
  const a = Array.from({ length: 400 }, () => random() % cellCount);
  const b = Array.from({ length: 400 }, () => random() % cellCount);
  const setA = new Set(a);
  const setB = new Set(b);
  const sorted = values => Array.from(values).sort((x, y) => x - y);
  const left = () => CellSet.from(a, cellCount);
  const right = CellSet.from(b, cellCount);
  const union = left().unionWith(right);
  assert.deepEqual(union.toArray(), sorted(new Set([...setA, ...setB])));
  assert.equal(union.size, new Set([...setA, ...setB]).size);
  const intersection = left().intersectWith(right);
  assert.deepEqual(intersection.toArray(), sorted([...setA].filter(cell => setB.has(cell))));
  const difference = left().subtract(right);
  assert.deepEqual(difference.toArray(), sorted([...setA].filter(cell => !setB.has(cell))));
  const original = left();
  const copy = original.clone().subtract(original);
  assert.equal(copy.size, 0);
  assert.equal(original.size, setA.size, 'a clone is independent');
  assert.throws(() => left().unionWith(new CellSet(cellCount + 1)), TypeError);
});

test('a CellSet holds more cells than a JS Set can', () => {
  const cellCount = 16_777_216 + 64;
  const set = new CellSet(cellCount);
  for (let cell = 0; cell < cellCount; cell++) set.add(cell);
  assert.equal(set.size, cellCount);
  assert.equal(set.has(cellCount - 1), true);
  assert.equal(set.clone().intersectWith(set).size, cellCount);
});

test('a cell list is checked in one pass, with no Set', () => {
  const list = Uint32Array.of(0, 2, 5);
  assert.equal(requireCellList(list, 6, 'cells'), list);
  assert.deepEqual(Array.from(CellSet.fromCellList(list, 6)), [0, 2, 5]);
  assert.throws(() => requireCellList([0, 2, 5], 6, 'cells'), /Uint32Array/);
  assert.throws(() => requireCellList(Uint32Array.of(0, 5, 2), 6, 'cells'), /ascending/);
  assert.throws(() => requireCellList(Uint32Array.of(0, 2, 2), 6, 'cells'), /ascending/);
  assert.throws(() => requireCellList(Uint32Array.of(0, 6), 6, 'cells'), /inside the current dataset of 6/);
  assert.equal(requireCellList(new Uint32Array(0), 0, 'cells').length, 0);
  assert.equal(cellListsEqual(Uint32Array.of(1, 4), Uint32Array.of(1, 4)), true);
  assert.equal(cellListsEqual(Uint32Array.of(1, 4), Uint32Array.of(1, 5)), false);
});

test('cells from outside the page become one cell list, sorted once', () => {
  assert.deepEqual(Array.from(cellListFrom([3, 1, 2], 4, 'cells')), [1, 2, 3]);
  assert.deepEqual(Array.from(cellListFrom([], 4, 'cells')), []);
  assert.throws(() => cellListFrom([3, 1, 3], 4, 'cells'), /duplicate/);
  assert.throws(() => cellListFrom([1, 4], 4, 'cells'), /outside the current dataset of 4/);
  assert.throws(() => cellListFrom([1, -1], 4, 'cells'), /non-negative integer/);
  assert.throws(() => cellListFrom([1, 1.5], 4, 'cells'), /non-negative integer/);
});

test('annotation candidates combine as CellSets', () => {
  const cellCount = 10;
  const start = CellSet.from([1, 2, 3], cellCount);
  const cases = [
    ['continuous', 'intersect', [2, 3, 4], [2, 3]],
    ['continuous', 'union', [5], [1, 2, 3, 5]],
    ['continuous', 'subtract', [2], [1, 3]],
    ['category', 'intersect', [7, 8], [7, 8]],
    ['category', 'union', [7], [1, 2, 3, 7]],
    ['category', 'subtract', [1], [2, 3]],
  ];
  for (const [fieldKind, mode, cellIndices, expected] of cases) {
    const { candidates } = combineAnnotationCandidates({
      candidates: start, cellIndices: Uint32Array.from(cellIndices), mode, fieldKind, cellCount,
    });
    assert.ok(candidates instanceof CellSet, `${fieldKind} ${mode}`);
    assert.deepEqual(candidates.toArray(), expected, `${fieldKind} ${mode}`);
  }
  assert.deepEqual(start.toArray(), [1, 2, 3], 'the standing candidates are never mutated');
  assert.throws(
    () => combineAnnotationCandidates({
      candidates: new Set([1]), cellIndices: new Uint32Array(0), mode: 'union', fieldKind: 'continuous', cellCount,
    }),
    /CellSet or null/,
  );
});

test('selection modules hold no cell-keyed Set or Map', async () => {
  // Each of these handles one entry a selected cell; a JS Set or Map there
  // fails above 2^24 cells. Small Sets of ids or modes elsewhere are fine.
  const modules = [
    'app/ui/modules/highlight/annotation-cells.js',
    'app/ui/modules/highlight/annotation-selection.js',
    'app/ui/modules/highlight/continuous-selection-preview.js',
    'app/ui/modules/highlight/selection-state.js',
    'app/jupyter-command-handler.js',
    'rendering/selection-gesture-queries.js',
  ];
  for (const path of modules) {
    const source = await readFile(new URL(`../assets/js/${path}`, import.meta.url), 'utf8');
    // Allowed: the pending-delivery handles and the de-duplicated failures.
    const cellSets = source.split('\n').filter(line => (
      /new (Set|Map)\(/.test(line)
      && !/pendingDeliveries = new Set\(\)|new Set\(failures\)/.test(line)
    ));
    assert.deepEqual(cellSets, [], path);
  }
  const highlight = await readFile(new URL('../assets/js/rendering/highlight-renderer.js', import.meta.url), 'utf8');
  assert.doesNotMatch(highlight, /new Set\((candidates|[a-z]*Candidates|neighbors|visited)/);
  assert.doesNotMatch(highlight, /visited = new Set/);
  const manager = await readFile(new URL('../assets/js/app/state/managers/highlight-manager.js', import.meta.url), 'utf8');
  assert.doesNotMatch(manager, /const seen = new Set\(\)/);
  const exact = await readFile(new URL('../assets/js/app/ui/modules/highlight/exact-contract.js', import.meta.url), 'utf8');
  assert.doesNotMatch(exact, /new Set\((cellIndices|values|indices|expectedCellIndices)/);
});
