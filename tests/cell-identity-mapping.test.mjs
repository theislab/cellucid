/**
 * The one mapping between open positions and original positions
 * (`data/cell-identity.js`), against a brute-force reference, for every kind
 * of opening: every cell or a subset, in original order or another one.
 * Every consumer that moves per-cell values across the boundary (pushed
 * columns, results, sessions, exports, selections) goes through it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createCellIdentity } from '../assets/js/data/cell-identity.js';
import { sharedOpenCells } from '../assets/js/data/anndata-file-source.js';

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function shuffled(values, next) {
  const out = Uint32Array.from(values);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Every kind of opening of `nObs` cells, with the original position of each open cell. */
function openings(nObs, next) {
  const every = Uint32Array.from({ length: nObs }, (_, i) => i);
  const kept = every.filter(() => next() < 0.6);
  const cases = [
    ['every cell, original order', { nObs }, every],
    ['every cell, another order', { nObs, openOrder: shuffled(every, next) }, null],
  ];
  if (kept.length > 0 && kept.length < nObs) {
    cases.push(['a subset, original order', { nObs, kept }, kept]);
    cases.push(['a subset, another order', { nObs, kept, openOrder: shuffled(kept, next) }, null]);
  }
  return cases.map(([label, options, order]) => [label, createCellIdentity(options), order ?? options.openOrder]);
}

test('every mapping agrees with the original position of each open cell', () => {
  const next = random(7);
  // Counts within one word of 32 cells, across several, and not a multiple of 32.
  for (const nObs of [1, 2, 3, 17, 32, 33, 200, 4099]) {
    for (const [label, identity, originalOf] of openings(nObs, next)) {
      const n = identity.n;
      const openOf = new Map(Array.from(originalOf, (original, open) => [original, open]));
      const at = `${label}, ${nObs} cells`;
      for (let i = 0; i < n; i++) assert.equal(identity.originalAt(i), originalOf[i], at);
      assert.deepEqual([...identity.toOriginal(Uint32Array.from({ length: n }, (_, i) => i))], [...originalOf], at);

      // Original positions in any order: each open one's open position, -1 elsewhere.
      const asked = shuffled(Uint32Array.from({ length: nObs }, (_, i) => i), next);
      assert.deepEqual([...identity.openPositionsOf(asked)], Array.from(asked, p => openOf.get(p) ?? -1), at);
      const { positions, dropped } = identity.fromOriginal(asked);
      assert.deepEqual([...positions], Array.from(asked, p => openOf.get(p)).filter(p => p !== undefined).sort((a, b) => a - b), at);
      assert.equal(dropped, nObs - n, at);

      // A column of every cell of the dataset, over the open cells.
      const column = Float32Array.from({ length: nObs }, (_, p) => 100 + p);
      assert.deepEqual([...identity.openValues({ cells: null, values: column }, Float32Array, NaN)], Array.from(originalOf, p => 100 + p), at);
      // A column of some cells: the rest missing.
      const some = Uint32Array.from(asked.slice(0, Math.ceil(nObs / 2))).sort();
      const someValues = Float64Array.from(some, p => -p);
      assert.deepEqual(
        [...identity.openValues({ cells: some, values: someValues }, Float64Array, NaN)],
        Array.from(originalOf, p => (some.includes(p) ? -p : NaN)),
        at,
      );

      // Values of every open cell named by original position, ascending, and back.
      const openColumn = Float32Array.from({ length: n }, (_, i) => 1000 + originalOf[i]);
      const out = identity.originalValues(null, openColumn);
      const ascending = [...originalOf].sort((a, b) => a - b);
      if (identity.isSubset) assert.deepEqual([...out.cells], ascending, at);
      else assert.equal(out.cells, null, at);
      assert.deepEqual([...out.values], ascending.map(p => 1000 + p), at);
      assert.deepEqual([...identity.openValues({ cells: out.cells, values: out.values }, Float32Array, NaN)], [...openColumn], at);
      // Some open cells, any order.
      const picked = shuffled(Uint32Array.from({ length: n }, (_, i) => i), next).slice(0, Math.ceil(n / 2));
      const pickedValues = Int32Array.from(picked, i => originalOf[i] * 3);
      const named = identity.originalValues(picked, pickedValues);
      assert.deepEqual([...named.cells], Array.from(picked, i => originalOf[i]).sort((a, b) => a - b), at);
      assert.deepEqual([...named.values], [...named.cells].map(p => p * 3), at);
      assert.deepEqual([...identity.originalValues(picked, null).cells], [...named.cells], at);

      // Open order against ascending original order (a session's order).
      const order = identity.ascendingOrder;
      if (identity.openOrder === null) {
        assert.equal(order, null, at);
      } else {
        for (let i = 0; i < n; i++) {
          assert.equal(ascending[order.toAscending[i]], originalOf[i], at);
          assert.equal(order.toOpen[order.toAscending[i]], i, at);
        }
      }
    }
  }
});

test('a column that does not fit the dataset is refused, not misplaced', () => {
  const identity = createCellIdentity({ nObs: 5, kept: Uint32Array.of(1, 3), openOrder: Uint32Array.of(3, 1) });
  assert.throws(() => identity.openValues({ cells: null, values: new Float32Array(4) }, Float32Array, NaN), /does not cover the 5 cells/);
  assert.throws(() => identity.openValues({ cells: Uint32Array.of(1), values: new Float32Array(2) }, Float32Array, NaN), /names 1 cell with 2 values/);
  assert.throws(() => identity.openPositionsOf([5]), /outside the 5 cells/);
  assert.throws(() => identity.originalValues([2], null), /outside the 2 open cells/);
  assert.throws(() => identity.originalValues(null, new Float32Array(3)), /3 values for the 2 open cells/);
});

test('an open order that is not the open cells, each once, is refused', () => {
  const kept = Uint32Array.of(1, 3, 40, 63, 64);
  const refused = /A cell order must list exactly the open cells, each once/;
  // A cell twice (and so one missing), a cell not open, a cell past the dataset.
  assert.throws(() => createCellIdentity({ nObs: 70, kept, openOrder: Uint32Array.of(3, 1, 40, 63, 3) }), refused);
  assert.throws(() => createCellIdentity({ nObs: 70, kept, openOrder: Uint32Array.of(3, 1, 40, 62, 64) }), refused);
  assert.throws(() => createCellIdentity({ nObs: 70, openOrder: Uint32Array.from({ length: 70 }, (_, i) => (i === 5 ? 70 : i)) }), refused);
  assert.throws(() => createCellIdentity({ nObs: 70, openOrder: Uint32Array.from({ length: 70 }, (_, i) => (i === 5 ? 6 : i)) }), refused);
  assert.throws(() => createCellIdentity({ nObs: 70, kept, openOrder: Uint32Array.of(1, 3) }), /A cell order must be a Uint32Array of the 5 open cells/);
  // The same cells in another order are accepted, and placed.
  const identity = createCellIdentity({ nObs: 70, kept, openOrder: Uint32Array.of(64, 1, 63, 40, 3) });
  assert.deepEqual([...identity.openPositionsOf(Uint32Array.of(1, 3, 40, 63, 64, 2))], [1, 4, 3, 2, 0, -1]);
});

test('the open cells two openings share first are counted as cell by cell', () => {
  const next = random(11);
  const nObs = 300;
  const every = Uint32Array.from({ length: nObs }, (_, i) => i);
  const order = shuffled(every, next);
  const prefix = k => Uint32Array.from(order.subarray(0, k)).sort();
  const openings = [
    createCellIdentity({ nObs }),
    createCellIdentity({ nObs, openOrder: order }),
    createCellIdentity({ nObs, kept: prefix(120), openOrder: order.slice(0, 120) }),
    createCellIdentity({ nObs, kept: prefix(200), openOrder: order.slice(0, 200) }),
    createCellIdentity({ nObs, kept: every.slice(0, 150) }),
    createCellIdentity({ nObs, kept: every.filter(i => i % 3 !== 1) }),
    createCellIdentity({ nObs: nObs + 1 }),
  ];
  const reference = (a, b) => {
    if (a.nOriginal !== b.nOriginal) return 0;
    let shared = 0;
    while (shared < Math.min(a.n, b.n) && a.originalAt(shared) === b.originalAt(shared)) shared++;
    return shared;
  };
  for (const a of openings) for (const b of openings) assert.equal(sharedOpenCells(a, b), reference(a, b));
  // A priority prefix is the whole order's first cells; every cell in file order shares its first 150 with the first 150.
  assert.equal(sharedOpenCells(openings[1], openings[2]), 120);
  assert.equal(sharedOpenCells(openings[0], openings[4]), 150);
});
