/**
 * Every sorted copy, order statistic and rank in the analysis layer comes from
 * the linear-time ordering kernels in compute/math-utils.js (radix sorting and
 * radix selection over order-preserving keys) instead of a comparison sort.
 * They must order exactly as the native numeric sort does — ascending, -0
 * before +0, NaN last — so every result built on them is the same number it
 * was. `Object.is` is the comparison throughout.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ascendingOrder,
  computeRanks,
  computeRanksWithTies,
  mannWhitneyU,
  selectSorted,
  sortedAscending
} from '../assets/js/app/analysis/compute/math-utils.js';
import { kruskalWallis } from '../assets/js/app/analysis/stats/statistical-tests.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Samples on every path: below and above both radix thresholds, float32 and not. */
function samples(seed) {
  const random = mulberry32(seed);
  const out = [];
  for (const n of [1, 7, 900, 1024, 5000, 140000]) {
    const f32 = new Float32Array(n);
    for (let i = 0; i < n; i++) f32[i] = Math.fround((random() - 0.5) * 2e3);
    const special = [-0, 0, -Infinity, Infinity, 1e-45, -1e-45, 3.4e38, -3.4e38];
    for (let i = 0; i < Math.min(n, special.length); i++) f32[(i * 37) % n] = special[i];
    out.push([`float32 ${n}`, f32]);

    const f64 = new Float64Array(n);
    for (let i = 0; i < n; i++) f64[i] = (random() - 0.5) * 10 ** Math.floor(random() * 600 - 300);
    const special64 = [-0, 0, 5e-324, -5e-324, Number.MAX_VALUE, -Number.MAX_VALUE, Infinity];
    for (let i = 0; i < Math.min(n, special64.length); i++) f64[(i * 41) % n] = special64[i];
    out.push([`float64 ${n}`, f64]);
    out.push([`array ${n}`, Array.from(f64)]);

    // Integer-valued: whole radix digits are shared and their passes skipped.
    const ints = new Float32Array(n);
    for (let i = 0; i < n; i++) ints[i] = Math.floor(random() * 40) - 20;
    out.push([`integers ${n}`, ints]);
    const int32 = new Int32Array(n);
    for (let i = 0; i < n; i++) int32[i] = Math.floor((random() - 0.5) * 4e9);
    out.push([`int32 ${n}`, int32]);

    const zeros = new Float64Array(n);
    for (let i = 0; i < n; i++) zeros[i] = i % 3 === 0 ? -0 : i % 3 === 1 ? 0 : random() - 0.5;
    out.push([`signed zeros ${n}`, zeros]);
  }
  return out;
}

test('sortedAscending is the native numeric sort, value for value', () => {
  for (const [label, values] of samples(11)) {
    const expected = Float64Array.from(values).sort();
    const actual = sortedAscending(values);
    assert.ok(actual instanceof Float64Array, label);
    assert.equal(actual.length, expected.length, label);
    for (let i = 0; i < expected.length; i++) {
      assert.ok(Object.is(actual[i], expected[i]), `${label} [${i}]: ${actual[i]} vs ${expected[i]}`);
    }
  }
  // NaN of either sign sorts last, as the native sort puts it.
  const withNaN = new Float64Array(3000).map((_, i) => (i % 7 === 0 ? (i % 2 ? NaN : -NaN) : i - 1500));
  const sorted = sortedAscending(withNaN);
  const native = Float64Array.from(withNaN).sort();
  for (let i = 0; i < native.length; i++) assert.ok(Object.is(sorted[i], native[i]), `NaN [${i}]`);
});

test('ascendingOrder is a stable permutation in native sort order', () => {
  for (const [label, values] of samples(12)) {
    const order = ascendingOrder(values);
    assert.ok(order instanceof Uint32Array, label);
    const native = Float64Array.from(values).sort();
    const seen = new Uint8Array(values.length);
    for (let k = 0; k < order.length; k++) {
      assert.equal(seen[order[k]], 0, `${label} repeats index ${order[k]}`);
      seen[order[k]] = 1;
      assert.ok(Object.is(Number(values[order[k]]), native[k]), `${label} position ${k}`);
      if (k > 0 && Object.is(Number(values[order[k]]), Number(values[order[k - 1]]))) {
        assert.ok(order[k] > order[k - 1], `${label} keeps equal values in index order at ${k}`);
      }
    }
  }
});

test('selectSorted reads any positions of the native sorted order, signed zeros included', () => {
  for (const [label, values] of samples(13)) {
    const finite = Array.from(values).filter(Number.isFinite);
    if (finite.length === 0) continue;
    const input = values instanceof Float32Array
      ? Float32Array.from(finite)
      : values instanceof Float64Array ? Float64Array.from(finite) : finite;
    const native = Float64Array.from(input).sort();
    const n = native.length;
    const positions = [n - 1, 0, Math.floor(n / 4), Math.floor(n / 2), Math.floor(n * 0.75), n >> 1, 0];
    const selected = selectSorted(input, positions);
    positions.forEach((position, i) => {
      assert.ok(
        Object.is(selected[i], native[position]),
        `${label} position ${position}: ${selected[i]} vs ${native[position]}`
      );
    });
  }
  // A tabulated sample whose zero block holds both signs.
  const quantized = Float32Array.from({ length: 4000 }, (_, i) => (i % 4 === 0 ? -0 : i % 4 === 1 ? 0 : i % 5));
  const native = Float64Array.from(quantized).sort();
  for (const position of [0, 999, 1000, 1999, 2000, 3999]) {
    assert.ok(Object.is(selectSorted(quantized, [position])[0], native[position]), `zero block ${position}`);
  }
});

/** Mid-ranks and the Map-order tie term, straight from the definitions. */
function referenceRanks(values) {
  const order = Array.from(values, (_, i) => i).sort((a, b) => values[a] - values[b] || a - b);
  const ranks = new Array(values.length);
  for (let i = 0; i < order.length;) {
    let j = i + 1;
    while (j < order.length && values[order[j]] === values[order[i]]) j++;
    for (let k = i; k < j; k++) ranks[order[k]] = (i + j + 1) / 2;
    i = j;
  }
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let tieTerm = 0;
  for (const count of counts.values()) if (count > 1) tieTerm += count ** 3 - count;
  return { ranks, tieTerm };
}

test('ranks and the tie term equal the definition on both rank strategies', () => {
  for (const [label, values] of samples(14)) {
    const finite = Float64Array.from(Array.from(values).filter(Number.isFinite));
    const expected = referenceRanks(finite);
    const actual = computeRanksWithTies(finite);
    assert.ok(Object.is(actual.tieTerm, expected.tieTerm), `${label} tie term`);
    assert.deepEqual(computeRanks(finite), actual.ranks);
    for (let i = 0; i < finite.length; i++) {
      assert.ok(Object.is(actual.ranks[i], expected.ranks[i]), `${label} rank ${i}`);
    }
  }
});

test('a tie block with t^3 past 2^53 keeps the tie term in first-occurrence order', () => {
  // Over the tabulation bound, so the linear-time order finds the blocks in
  // ascending order. A thousand pairs occur first and a block of 300,001
  // equal values (whose cube is past 2^53) sorts first: summed in ascending
  // order, every pair's 6 is rounded away; summed in first-occurrence order,
  // the pairs accumulate before the block is added. The two sums differ.
  const values = [];
  for (let i = 0; i < 1000; i++) values.push(100 + i, 100 + i);
  for (let i = 0; i < 300001; i++) values.push(-3);
  for (let i = 0; i < 5000; i++) values.push(5000 + i * 0.5);
  const pooled = Float64Array.from(values);
  const expected = referenceRanks(pooled);
  let ascending = 0;
  ascending += 300001 ** 3 - 300001;
  for (let i = 0; i < 1000; i++) ascending += 6;
  assert.notEqual(ascending, expected.tieTerm, 'the fixture must make the order visible');
  const actual = computeRanksWithTies(pooled);
  assert.ok(Object.is(actual.tieTerm, expected.tieTerm), `${actual.tieTerm} vs ${expected.tieTerm}`);

  // Kruskal-Wallis pools its groups in order and corrects by this tie term.
  const groups = [pooled.subarray(0, 2000), pooled.subarray(2000, 302001), pooled.subarray(302001)];
  const h = kruskalWallis(groups);
  assert.ok(Number.isFinite(h.statistic));
});

test('Mann-Whitney over merged sorted samples equals the rank-sum definition', () => {
  const random = mulberry32(16);
  const a = Float32Array.from({ length: 30000 }, () => Math.fround(random() * 50 - 25));
  const b = Float32Array.from({ length: 22000 }, () => (random() < 0.4 ? 0 : Math.fround(random() * 40 - 10)));
  a[0] = -0;
  const pooled = Float64Array.from([...a, ...b]);
  const { ranks, tieTerm } = referenceRanks(pooled);
  let rankSumA = 0;
  for (let i = 0; i < a.length; i++) rankSumA += ranks[i];
  const result = mannWhitneyU(a, b);
  assert.ok(Object.is(result.u1, rankSumA - (a.length * (a.length + 1)) / 2));
  const reference = mannWhitneyU(Array.from(a), Array.from(b));
  assert.ok(Object.is(result.pValue, reference.pValue));
  assert.ok(tieTerm > 0);
});
